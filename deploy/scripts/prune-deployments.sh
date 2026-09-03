#!/usr/bin/env bash
set -euo pipefail

readonly APP_ROOT="/opt/english-typing-practice"
readonly RELEASE_ROOT="${APP_ROOT}/releases"
readonly CURRENT_LINK="${APP_ROOT}/current"
readonly PREVIOUS_LINK="${APP_ROOT}/previous"
readonly DEPLOYMENT_ROOT="/var/lib/english-typing-practice-deployments"
readonly BACKUP_ROOT="/var/backups/english-typing-practice"
readonly DEPLOY_LOCK="/var/lib/english-typing-practice-locks/deploy.lock"
readonly RETAIN_COUNT=5

log() {
  printf '[englishapp-prune] %s\n' "$*" >&2
}

die() {
  log "ERROR: $*"
  exit 1
}

[[ "${EUID}" -eq 0 ]] || die "run this script as root"
[[ $# -eq 0 ]] || die "usage: prune-deployments.sh"
for command_path in /usr/bin/find /usr/bin/realpath /usr/bin/flock /usr/bin/sort; do
  [[ -x "$command_path" ]] || die "required command is missing: ${command_path}"
done

if [[ "${ETP_DEPLOY_LOCK_HELD:-0}" != "1" ]]; then
  [[ -f "$DEPLOY_LOCK" && ! -L "$DEPLOY_LOCK" ]] || die "deployment lock is missing or unsafe"
  exec 9>"$DEPLOY_LOCK"
  /usr/bin/flock -n 9 || die "another deployment or rollback is already running"
fi

for fixed_dir in "$APP_ROOT" "$RELEASE_ROOT" "$DEPLOYMENT_ROOT"; do
  [[ -d "$fixed_dir" && ! -L "$fixed_dir" ]] || die "unsafe fixed directory: ${fixed_dir}"
done

declare -A keep_state=()
declare -A keep_release=()
declare -A keep_backup=()
declare -a removable_states=()
declare -a removable_backups=()

release_id_from_target() {
  local target="$1"
  case "$target" in
    "${RELEASE_ROOT}"/[0-9a-f]*) ;;
    *) return 1 ;;
  esac
  local id
  id="$(/usr/bin/basename -- "$target")"
  [[ "$id" =~ ^[0-9a-f]{7,64}$ && "$target" == "${RELEASE_ROOT}/${id}" ]] || return 1
  printf '%s\n' "$id"
}

protect_link_target() {
  local link_path="$1"
  [[ ! -e "$link_path" && ! -L "$link_path" ]] && return 0
  [[ -L "$link_path" ]] || die "protected pointer is not a symlink: ${link_path}"
  local target id
  target="$(/usr/bin/realpath -e -- "$link_path")"
  id="$(release_id_from_target "$target")" || die "protected pointer escapes the release root: ${link_path}"
  [[ -d "$target" && ! -L "$target" ]] || die "protected release target is invalid: ${target}"
  keep_release["$id"]=1
  [[ ! -d "${DEPLOYMENT_ROOT}/${id}" ]] || keep_state["$id"]=1
}

protect_link_target "$CURRENT_LINK"
protect_link_target "$PREVIOUS_LINK"

mapfile -t ordered_states < <(
  /usr/bin/find "$DEPLOYMENT_ROOT" -mindepth 1 -maxdepth 1 -type d -printf '%T@ %f\n' |
    LC_ALL=C /usr/bin/sort -nr | /usr/bin/cut -d' ' -f2-
)

terminal_kept=0
for id in "${ordered_states[@]}"; do
  [[ "$id" =~ ^[0-9a-f]{7,64}$ ]] || die "unexpected deployment state directory: ${id}"
  state_dir="${DEPLOYMENT_ROOT}/${id}"
  [[ "$(/usr/bin/realpath -e -- "$state_dir")" == "$state_dir" && ! -L "$state_dir" ]] || die "unsafe deployment state: ${state_dir}"
  terminal=0
  [[ ! -L "${state_dir}/deployed-success" && ! -L "${state_dir}/rollback-complete" ]] || die "unsafe terminal marker in state ${id}"
  [[ -f "${state_dir}/deployed-success" || -f "${state_dir}/rollback-complete" ]] && terminal=1
  if [[ "$terminal" -eq 0 ]]; then
    keep_state["$id"]=1
  elif [[ "$terminal_kept" -lt "$RETAIN_COUNT" ]]; then
    keep_state["$id"]=1
    terminal_kept=$((terminal_kept + 1))
  fi
done

# Every retained state protects both release pointers and its pre-migration snapshot.
for id in "${!keep_state[@]}"; do
  state_dir="${DEPLOYMENT_ROOT}/${id}"
  [[ -d "$state_dir" ]] || continue
  [[ ! -d "${RELEASE_ROOT}/${id}" ]] || keep_release["$id"]=1
  for pointer_name in new-target previous-target; do
    pointer="${state_dir}/${pointer_name}"
    [[ -f "$pointer" && ! -L "$pointer" ]] || continue
    IFS= read -r target <"$pointer"
    [[ "$target" == "NONE" ]] && continue
    target_id="$(release_id_from_target "$target")" || die "unsafe ${pointer_name} in retained state ${id}"
    [[ -d "$target" && ! -L "$target" ]] || die "missing release referenced by retained state ${id}"
    keep_release["$target_id"]=1
  done
  database_pointer="${state_dir}/database-before"
  if [[ -f "$database_pointer" && ! -L "$database_pointer" ]]; then
    IFS= read -r backup <"$database_pointer"
    if [[ "$backup" != "NO_DATABASE" ]]; then
      case "$backup" in
        "${BACKUP_ROOT}"/pre-migration/*.sqlite3) ;;
        *) die "unsafe database snapshot in retained state ${id}" ;;
      esac
      [[ "$(/usr/bin/basename -- "$backup")" =~ ^pre-migration-[0-9]{8}T[0-9]{6}\.[0-9]{9}Z\.sqlite3$ ]] ||
        die "unmanaged database snapshot name in retained state ${id}"
      [[ -f "$backup" && ! -L "$backup" ]] || die "missing database snapshot for retained state ${id}"
      keep_backup["$backup"]=1
    fi
  fi
done

# Keep at least the five newest immutable releases even if old state was already absent.
mapfile -t ordered_releases < <(
  /usr/bin/find "$RELEASE_ROOT" -mindepth 1 -maxdepth 1 -type d -printf '%T@ %f\n' |
    LC_ALL=C /usr/bin/sort -nr | /usr/bin/cut -d' ' -f2-
)
release_kept=0
for id in "${ordered_releases[@]}"; do
  if [[ ! "$id" =~ ^[0-9a-f]{7,64}$ ]]; then
    keep_release["$id"]=1
    log "retaining unrecognized release workspace for operator review: ${id}"
    continue
  fi
  if [[ "$release_kept" -lt "$RETAIN_COUNT" ]]; then
    keep_release["$id"]=1
    release_kept=$((release_kept + 1))
  fi
done

for id in "${ordered_states[@]}"; do
  [[ -n "${keep_state[$id]:-}" ]] && continue
  state_dir="${DEPLOYMENT_ROOT}/${id}"
  database_pointer="${state_dir}/database-before"
  if [[ -f "$database_pointer" && ! -L "$database_pointer" ]]; then
    IFS= read -r backup <"$database_pointer"
    if [[ "$backup" != "NO_DATABASE" ]]; then
      case "$backup" in
        "${BACKUP_ROOT}"/pre-migration/*.sqlite3) ;;
        *) die "unsafe database snapshot in removable state ${id}" ;;
      esac
      [[ "$(/usr/bin/basename -- "$backup")" =~ ^pre-migration-[0-9]{8}T[0-9]{6}\.[0-9]{9}Z\.sqlite3$ ]] ||
        die "unmanaged database snapshot name in removable state ${id}"
      removable_backups+=("$backup")
    fi
  fi
  removable_states+=("$state_dir")
done

safe_remove_tree() {
  local target="$1"
  local expected_parent="$2"
  [[ -d "$target" && ! -L "$target" ]] || die "refusing to remove unsafe tree: ${target}"
  [[ "$(/usr/bin/dirname -- "$target")" == "$expected_parent" ]] || die "refusing to remove tree outside ${expected_parent}"
  /usr/bin/find "$target" -xdev -depth -mindepth 1 -delete
  /usr/bin/rmdir -- "$target"
}

for state_dir in "${removable_states[@]}"; do
  safe_remove_tree "$state_dir" "$DEPLOYMENT_ROOT"
  log "removed old terminal deployment state $(/usr/bin/basename -- "$state_dir")"
done

for id in "${ordered_releases[@]}"; do
  [[ -n "${keep_release[$id]:-}" ]] && continue
  safe_remove_tree "${RELEASE_ROOT}/${id}" "$RELEASE_ROOT"
  log "removed old unreferenced release ${id}"
done

for backup in "${removable_backups[@]}"; do
  [[ -z "${keep_backup[$backup]:-}" ]] || continue
  case "$backup" in
    "${BACKUP_ROOT}"/pre-migration/*.sqlite3) ;;
    *) die "refusing to remove unsafe deployment snapshot: ${backup}" ;;
  esac
  [[ "$(/usr/bin/basename -- "$backup")" =~ ^pre-migration-[0-9]{8}T[0-9]{6}\.[0-9]{9}Z\.sqlite3$ ]] ||
    die "refusing to remove snapshot with an unmanaged filename"
  [[ ! -e "$backup" ]] && continue
  [[ -f "$backup" && ! -L "$backup" ]] || die "unsafe deployment snapshot: ${backup}"
  still_referenced=0
  while IFS= read -r pointer; do
    if /usr/bin/grep -Fqx -- "$backup" "$pointer"; then
      still_referenced=1
      break
    fi
  done < <(/usr/bin/find "$DEPLOYMENT_ROOT" -mindepth 2 -maxdepth 2 -type f -name database-before -print)
  if [[ "$still_referenced" -eq 0 ]]; then
    /usr/bin/rm -f -- "$backup"
    log "removed unreferenced pre-migration snapshot $(/usr/bin/basename -- "$backup")"
  fi
done

log "retained five recent terminal states/releases plus every active, previous, or incomplete reference"

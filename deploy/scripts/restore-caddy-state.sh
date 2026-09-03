#!/usr/bin/env bash
set -euo pipefail

readonly CADDY_MAIN="/etc/caddy/Caddyfile"
readonly CADDY_SITE="/etc/caddy/english-typing-practice.caddy"
readonly DEPLOYMENT_ROOT="/var/lib/english-typing-practice-deployments"

log() {
  printf '[englishapp-caddy-restore] %s\n' "$*" >&2
}

die() {
  log "ERROR: $*"
  exit 1
}

[[ "${EUID}" -eq 0 ]] || die "run this script as root"
[[ $# -ge 1 && $# -le 2 ]] || die "usage: restore-caddy-state.sh <release-id> [--check-only]"
readonly release_id="$1"
readonly restore_mode="${2:-}"
[[ -z "$restore_mode" || "$restore_mode" == "--check-only" ]] || die "unknown restore mode: ${restore_mode}"
[[ "$release_id" =~ ^[0-9a-f]{7,64}$ ]] || die "invalid release id"
readonly state_dir="${DEPLOYMENT_ROOT}/${release_id}"
readonly main_backup="${state_dir}/Caddyfile.before"
readonly site_backup="${state_dir}/caddy-site.before"
readonly site_absent="${state_dir}/caddy-site.was-absent"
readonly change_marker="${state_dir}/caddy-change-started"
readonly activated_marker="${state_dir}/caddy-activated"
readonly restored_marker="${state_dir}/caddy-restored"
readonly main_after_hash="${state_dir}/Caddyfile.after.sha256"
readonly site_after_hash="${state_dir}/caddy-site.after.sha256"

[[ -f "$change_marker" || -f "$activated_marker" ]] || {
  log "Caddy was not changed for release ${release_id}; nothing to restore"
  exit 0
}
[[ ! -f "$restored_marker" ]] || {
  log "Caddy state for release ${release_id} was already restored"
  exit 0
}
[[ -f "$main_backup" && ! -L "$main_backup" ]] || die "missing safe Caddyfile backup"
if [[ -f "$site_backup" ]]; then
  [[ ! -L "$site_backup" ]] || die "unsafe Caddy site backup"
else
  [[ -f "$site_absent" && ! -L "$site_absent" ]] || die "missing prior site state"
fi
for command_path in /usr/bin/caddy /usr/bin/mktemp /usr/bin/systemctl /usr/bin/sha256sum /usr/bin/awk; do
  [[ -x "$command_path" ]] || die "required command is missing: ${command_path}"
done
[[ -f "$CADDY_MAIN" && ! -L "$CADDY_MAIN" ]] || die "active Caddyfile is unsafe"
if [[ -e "$CADDY_SITE" ]]; then
  [[ -f "$CADDY_SITE" && ! -L "$CADDY_SITE" ]] || die "active Caddy site must be a regular, non-symlink file"
fi
if [[ -f "$activated_marker" ]]; then
  for hash_file in "$main_after_hash" "$site_after_hash"; do
    [[ -f "$hash_file" && ! -L "$hash_file" ]] || die "missing safe post-activation Caddy hash: ${hash_file}"
    expected_hash="$(<"$hash_file")"
    [[ "$expected_hash" =~ ^[0-9a-f]{64}$ ]] || die "invalid post-activation Caddy hash: ${hash_file}"
  done
  [[ "$(/usr/bin/sha256sum -- "$CADDY_MAIN" | /usr/bin/awk '{print $1}')" == "$(<"$main_after_hash")" ]] ||
    die "active Caddyfile changed after this release; refusing to overwrite later operator/robot changes"
  [[ -f "$CADDY_SITE" && ! -L "$CADDY_SITE" ]] || die "managed Caddy site disappeared after activation"
  [[ "$(/usr/bin/sha256sum -- "$CADDY_SITE" | /usr/bin/awk '{print $1}')" == "$(<"$site_after_hash")" ]] ||
    die "managed Caddy site changed after this release; refusing to overwrite later changes"
fi
if [[ "$restore_mode" == "--check-only" ]]; then
  log "active Caddy files still match the recorded post-activation hashes"
  exit 0
fi

readonly current_main="$(/usr/bin/mktemp /etc/caddy/.Caddyfile.current.XXXXXX)"
readonly current_site="$(/usr/bin/mktemp /etc/caddy/.english-site.current.XXXXXX)"
current_site_existed=0
/usr/bin/cp --preserve=mode,ownership,timestamps -- "$CADDY_MAIN" "$current_main"
if [[ -f "$CADDY_SITE" ]]; then
  /usr/bin/cp --preserve=mode,ownership,timestamps -- "$CADDY_SITE" "$current_site"
  current_site_existed=1
fi
committed=0

atomic_copy_with_reference() {
  local source_path="$1"
  local target_path="$2"
  local reference_path="$3"
  local temp_path
  temp_path="$(/usr/bin/mktemp "$(/usr/bin/dirname -- "$target_path")/.$(/usr/bin/basename -- "$target_path").restore.XXXXXX")" || return 1
  /usr/bin/cp -- "$source_path" "$temp_path" || return 1
  /usr/bin/chown --reference="$reference_path" "$temp_path" || return 1
  /usr/bin/chmod --reference="$reference_path" "$temp_path" || return 1
  /usr/bin/mv -Tf -- "$temp_path" "$target_path" || return 1
}

install_pair() {
  local main_source="$1"
  local site_source="$2"
  local site_exists="$3"
  if [[ "$site_exists" -eq 1 ]]; then
    atomic_copy_with_reference "$site_source" "$CADDY_SITE" "$site_source" || return 1
    atomic_copy_with_reference "$main_source" "$CADDY_MAIN" "$main_source" || return 1
  else
    atomic_copy_with_reference "$main_source" "$CADDY_MAIN" "$main_source" || return 1
    /usr/bin/rm -f -- "$CADDY_SITE" || return 1
  fi
}

cleanup() {
  /usr/bin/rm -f -- "$current_main" "$current_site"
}

on_exit() {
  local status=$?
  trap - EXIT HUP INT TERM
  if [[ "$status" -ne 0 && "$committed" -eq 0 ]]; then
    log "restore interrupted; reinstating the configuration that was active on entry"
    install_pair "$current_main" "$current_site" "$current_site_existed" || true
    /usr/bin/caddy validate --config "$CADDY_MAIN" --adapter caddyfile >/dev/null 2>&1 || true
    /usr/bin/systemctl reload caddy.service || true
  fi
  cleanup || true
  exit "$status"
}
trap on_exit EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

if [[ -f "$site_backup" ]]; then
  install_pair "$main_backup" "$site_backup" 1
else
  install_pair "$main_backup" "$site_backup" 0
fi

/usr/bin/caddy validate --config "$CADDY_MAIN" --adapter caddyfile || die "saved Caddy state does not validate"
/usr/bin/systemctl reload caddy.service || die "saved Caddy state could not be reloaded"
/usr/bin/install -m 0600 -o root -g root /dev/null "$restored_marker"
committed=1
trap - EXIT HUP INT TERM
cleanup
log "previous Caddy configuration and metadata restored atomically"

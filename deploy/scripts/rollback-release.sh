#!/usr/bin/env bash
set -euo pipefail

readonly APP_ROOT="/opt/english-typing-practice"
readonly RELEASE_ROOT="${APP_ROOT}/releases"
readonly CURRENT_LINK="${APP_ROOT}/current"
readonly DATA_DIR="/var/lib/english-typing-practice"
readonly DATABASE_PATH="${DATA_DIR}/app.db"
readonly DEPLOYMENT_ROOT="/var/lib/english-typing-practice-deployments"
readonly BACKUP_ROOT="/var/backups/english-typing-practice"
readonly FAILED_ROOT="${BACKUP_ROOT}/failed-deployments"
readonly SERVICE_NAME="englishapp.service"
readonly HEALTH_URL="http://127.0.0.1:8091/api/healthz"
readonly LIBEXEC_DIR="/usr/local/libexec/english-typing-practice"
readonly DEPLOY_LOCK="/var/lib/english-typing-practice-locks/deploy.lock"
readonly CADDY_MAIN="/etc/caddy/Caddyfile"
readonly CADDY_SITE="/etc/caddy/english-typing-practice.caddy"

log() {
  printf '[englishapp-rollback] %s\n' "$*" >&2
}

die() {
  log "ERROR: $*"
  exit 1
}

[[ "${EUID}" -eq 0 ]] || die "run this script as root"
[[ $# -eq 2 ]] || die "usage: rollback-release.sh <release-id> <--automatic|--keep-database|--restore-database>"
readonly release_id="$1"
readonly rollback_mode="$2"
[[ "$release_id" =~ ^[0-9a-f]{7,64}$ ]] || die "invalid release id"
case "$rollback_mode" in
  --automatic|--keep-database|--restore-database) ;;
  *) die "choose explicitly whether to keep or restore the database" ;;
esac
if [[ "$rollback_mode" == "--automatic" && "${ETP_DEPLOY_LOCK_HELD:-0}" != "1" ]]; then
  die "--automatic is reserved for deploy-release.sh"
fi

for command_path in /usr/bin/awk /usr/bin/caddy /usr/bin/curl /usr/bin/flock /usr/bin/mktemp /usr/bin/realpath /usr/bin/sha256sum /usr/bin/sqlite3 /usr/bin/systemctl; do
  [[ -x "$command_path" ]] || die "required command is missing: ${command_path}"
done
for helper in backup-sqlite.sh restore-sqlite.sh restore-caddy-state.sh; do
  [[ -x "${LIBEXEC_DIR}/${helper}" ]] || die "rollback helper is missing: ${LIBEXEC_DIR}/${helper}"
done

if [[ "${ETP_DEPLOY_LOCK_HELD:-0}" != "1" ]]; then
  [[ -f "$DEPLOY_LOCK" && ! -L "$DEPLOY_LOCK" ]] || die "deployment lock is missing or unsafe"
  exec 9>"$DEPLOY_LOCK"
  /usr/bin/flock -n 9 || die "another deployment or rollback is already running"
fi

readonly state_dir="${DEPLOYMENT_ROOT}/${release_id}"
readonly restored_marker="${state_dir}/caddy-restored"
[[ -d "$state_dir" && ! -L "$state_dir" ]] || die "missing deployment state: ${state_dir}"
[[ ! -e "${state_dir}/rollback-complete" ]] || {
  log "release ${release_id} was already rolled back"
  exit 0
}
for state_file in new-target previous-target service-was-active database-before; do
  [[ -f "${state_dir}/${state_file}" && ! -L "${state_dir}/${state_file}" ]] || die "missing safe state file: ${state_file}"
done

IFS= read -r new_target <"${state_dir}/new-target"
IFS= read -r previous_target <"${state_dir}/previous-target"
IFS= read -r service_was_active <"${state_dir}/service-was-active"
IFS= read -r database_before <"${state_dir}/database-before"
[[ "$new_target" == "${RELEASE_ROOT}/${release_id}" && -d "$new_target" && ! -L "$new_target" ]] || die "invalid new release target in state"
[[ "$service_was_active" == "0" || "$service_was_active" == "1" ]] || die "invalid prior service state"
if [[ "$previous_target" != "NONE" ]]; then
  case "$previous_target" in
    "${RELEASE_ROOT}"/[0-9a-f]*) ;;
    *) die "previous target escapes the fixed release root" ;;
  esac
  [[ -d "$previous_target" && ! -L "$previous_target" ]] || die "previous release is unavailable"
fi
if [[ "$database_before" != "NO_DATABASE" ]]; then
  case "$database_before" in
    "${BACKUP_ROOT}"/pre-migration/*.sqlite3) ;;
    *) die "database backup path is outside the pre-migration backup directory" ;;
  esac
  [[ -f "$database_before" && ! -L "$database_before" ]] || die "pre-migration backup is unavailable"
  [[ "$(/usr/bin/sqlite3 -readonly "$database_before" 'PRAGMA integrity_check;' 2>&1)" == "ok" ]] || die "pre-migration backup failed integrity validation"
fi

entry_current_target="NONE"
if [[ -e "$CURRENT_LINK" || -L "$CURRENT_LINK" ]]; then
  [[ -L "$CURRENT_LINK" ]] || die "current is not a symlink"
  entry_current_target="$(/usr/bin/realpath -e -- "$CURRENT_LINK")"
  if [[ "$entry_current_target" != "$new_target" && "$entry_current_target" != "$previous_target" ]]; then
    die "current points to an unrelated release; refusing rollback"
  fi
elif [[ "$previous_target" != "NONE" ]]; then
  die "current symlink is unexpectedly absent"
fi

# Guard before creating state, stopping the service, or changing any live file. A later
# Caddy/robot edit makes this rollback refuse rather than overwrite operator work.
"${LIBEXEC_DIR}/restore-caddy-state.sh" "$release_id" --check-only

readonly attempt_dir="$(/usr/bin/mktemp -d "${state_dir}/rollback-attempt.XXXXXX")"
/usr/bin/chown root:root "$attempt_dir"
/usr/bin/chmod 0700 "$attempt_dir"
printf '%s\n' "$entry_current_target" >"${attempt_dir}/current-before"
if /usr/bin/systemctl is-active --quiet "$SERVICE_NAME"; then
  entry_service_active=1
else
  entry_service_active=0
fi
printf '%s\n' "$entry_service_active" >"${attempt_dir}/service-before"
/usr/bin/chmod 0600 "${attempt_dir}/current-before" "${attempt_dir}/service-before"

[[ -f "$CADDY_MAIN" && ! -L "$CADDY_MAIN" ]] || die "active Caddyfile is unsafe"
/usr/bin/cp -a -- "$CADDY_MAIN" "${attempt_dir}/Caddyfile.entry"
entry_site_existed=0
if [[ -e "$CADDY_SITE" ]]; then
  [[ -f "$CADDY_SITE" && ! -L "$CADDY_SITE" ]] || die "active Caddy site is unsafe"
  /usr/bin/cp -a -- "$CADDY_SITE" "${attempt_dir}/caddy-site.entry"
  entry_site_existed=1
fi
entry_restored_marker_existed=0
[[ -f "$restored_marker" ]] && entry_restored_marker_existed=1

atomic_copy_with_reference() {
  local source_path="$1"
  local target_path="$2"
  local temp_path
  temp_path="$(/usr/bin/mktemp "$(/usr/bin/dirname -- "$target_path")/.$(/usr/bin/basename -- "$target_path").rollback.XXXXXX")" || return 1
  /usr/bin/cp -- "$source_path" "$temp_path" || return 1
  /usr/bin/chown --reference="$source_path" "$temp_path" || return 1
  /usr/bin/chmod --reference="$source_path" "$temp_path" || return 1
  /usr/bin/mv -Tf -- "$temp_path" "$target_path" || return 1
}

set_current_target() {
  local target="$1"
  local pending
  if [[ "$target" == "NONE" ]]; then
    [[ ! -e "$CURRENT_LINK" && ! -L "$CURRENT_LINK" ]] || {
      [[ -L "$CURRENT_LINK" ]] || return 1
      /usr/bin/rm -- "$CURRENT_LINK" || return 1
    }
    return 0
  fi
  [[ -d "$target" && ! -L "$target" ]] || return 1
  pending="${APP_ROOT}/.rollback-current-${release_id}-$$"
  /usr/bin/rm -f -- "$pending" || return 1
  /usr/bin/ln -s -- "releases/$(/usr/bin/basename -- "$target")" "$pending" || return 1
  /usr/bin/mv -Tf -- "$pending" "$CURRENT_LINK" || return 1
}

restore_entry_caddy() {
  local expected_main="${state_dir}/Caddyfile.before"
  local expected_site="${state_dir}/caddy-site.before"
  local expected_absent="${state_dir}/caddy-site.was-absent"
  local main_allowed=0
  local site_allowed=0
  local current_main_hash current_site_hash=""
  [[ -f "$CADDY_MAIN" && ! -L "$CADDY_MAIN" ]] || return 1
  current_main_hash="$(/usr/bin/sha256sum -- "$CADDY_MAIN" | /usr/bin/awk '{print $1}')"
  for candidate_main in "${attempt_dir}/Caddyfile.entry" "$expected_main"; do
    if [[ -f "$candidate_main" && ! -L "$candidate_main" ]] &&
       [[ "$current_main_hash" == "$(/usr/bin/sha256sum -- "$candidate_main" | /usr/bin/awk '{print $1}')" ]]; then
      main_allowed=1
    fi
  done
  [[ "$main_allowed" -eq 1 ]] || return 1
  if [[ -f "$CADDY_SITE" && ! -L "$CADDY_SITE" ]]; then
    current_site_hash="$(/usr/bin/sha256sum -- "$CADDY_SITE" | /usr/bin/awk '{print $1}')"
    for candidate_site in "${attempt_dir}/caddy-site.entry" "$expected_site"; do
      if [[ -f "$candidate_site" && ! -L "$candidate_site" ]] &&
         [[ "$current_site_hash" == "$(/usr/bin/sha256sum -- "$candidate_site" | /usr/bin/awk '{print $1}')" ]]; then
        site_allowed=1
      fi
    done
  elif [[ ! -e "$CADDY_SITE" && ! -L "$CADDY_SITE" ]]; then
    if [[ "$entry_site_existed" -eq 0 || ( -f "$expected_absent" && ! -L "$expected_absent" ) ]]; then
      site_allowed=1
    fi
  fi
  [[ "$site_allowed" -eq 1 ]] || return 1
  if [[ "$entry_site_existed" -eq 1 ]]; then
    atomic_copy_with_reference "${attempt_dir}/caddy-site.entry" "$CADDY_SITE" || return 1
    atomic_copy_with_reference "${attempt_dir}/Caddyfile.entry" "$CADDY_MAIN" || return 1
  else
    atomic_copy_with_reference "${attempt_dir}/Caddyfile.entry" "$CADDY_MAIN" || return 1
    /usr/bin/rm -f -- "$CADDY_SITE" || return 1
  fi
  /usr/bin/caddy validate --config "$CADDY_MAIN" --adapter caddyfile >/dev/null || return 1
  /usr/bin/systemctl reload caddy.service || return 1
  if [[ "$entry_restored_marker_existed" -eq 0 ]]; then
    /usr/bin/rm -f -- "$restored_marker" || return 1
  fi
}

quarantine_active_database() {
  local label="$1"
  local quarantine_dir
  [[ -d "$FAILED_ROOT" && ! -L "$FAILED_ROOT" ]] || return 1
  quarantine_dir="$(/usr/bin/mktemp -d "${FAILED_ROOT}/${release_id}-${label}.XXXXXX")" || return 1
  /usr/bin/chown root:root "$quarantine_dir" || return 1
  /usr/bin/chmod 0700 "$quarantine_dir" || return 1
  if [[ -e "$DATABASE_PATH" ]]; then
    [[ -f "$DATABASE_PATH" && ! -L "$DATABASE_PATH" ]] || return 1
    /usr/bin/mv -- "$DATABASE_PATH" "${quarantine_dir}/app.db" || return 1
  fi
  for suffix in -wal -shm; do
    if [[ -e "${DATABASE_PATH}${suffix}" ]]; then
      [[ -f "${DATABASE_PATH}${suffix}" && ! -L "${DATABASE_PATH}${suffix}" ]] || return 1
      /usr/bin/mv -- "${DATABASE_PATH}${suffix}" "${quarantine_dir}/app.db${suffix}" || return 1
    fi
  done
  log "database files quarantined at ${quarantine_dir}"
}

restart_entry_service() {
  if [[ "$entry_service_active" -eq 1 && "$entry_current_target" != "NONE" ]]; then
    /usr/bin/systemctl start "$SERVICE_NAME" || return 1
  else
    /usr/bin/systemctl stop "$SERVICE_NAME" >/dev/null 2>&1 || return 1
  fi
}

restart_only_armed=1
transaction_armed=0
rollback_committed=0
entry_database_backup=""
caddy_changed=0

recover_entry_state() {
  local recovery_failed=0
  /usr/bin/systemctl stop "$SERVICE_NAME" >/dev/null 2>&1 || true
  set_current_target "$entry_current_target" || recovery_failed=1
  if [[ "$entry_database_backup" == "NO_DATABASE" ]]; then
    quarantine_active_database rollback-recovery || recovery_failed=1
  elif [[ -n "$entry_database_backup" ]]; then
    ETP_DEPLOY_LOCK_HELD=1 "${LIBEXEC_DIR}/restore-sqlite.sh" "$entry_database_backup" --leave-stopped >/dev/null || recovery_failed=1
  else
    recovery_failed=1
  fi
  if [[ "$caddy_changed" -eq 1 ]]; then
    restore_entry_caddy || recovery_failed=1
  fi
  restart_entry_service || recovery_failed=1
  [[ "$recovery_failed" -eq 0 ]]
}

on_exit() {
  local status=$?
  trap - EXIT HUP INT TERM
  if [[ "$status" -ne 0 && "$rollback_committed" -eq 0 ]]; then
    /usr/bin/rm -f -- "${state_dir}/rollback-complete" "${attempt_dir}/rollback-succeeded" || true
    if [[ "$transaction_armed" -eq 1 ]]; then
      log "rollback failed or was interrupted; restoring its complete entry state"
      recover_entry_state || log "CRITICAL: rollback entry-state recovery needs operator attention (${attempt_dir})"
    elif [[ "$restart_only_armed" -eq 1 && "$entry_service_active" -eq 1 ]]; then
      /usr/bin/systemctl start "$SERVICE_NAME" || log "CRITICAL: entry service could not be restarted"
    fi
  fi
  exit "$status"
}
trap on_exit EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

/usr/bin/systemctl stop "$SERVICE_NAME"
entry_database_backup="$("${LIBEXEC_DIR}/backup-sqlite.sh" pre-restore)"
printf '%s\n' "$entry_database_backup" >"${attempt_dir}/rollback-entry-database"
/usr/bin/chmod 0600 "${attempt_dir}/rollback-entry-database"
transaction_armed=1
restart_only_armed=0

set_current_target "$previous_target" || die "could not atomically switch to the previous release"

restore_database=0
[[ "$rollback_mode" == "--automatic" || "$rollback_mode" == "--restore-database" ]] && restore_database=1
if [[ "$restore_database" -eq 1 ]]; then
  if [[ "$database_before" == "NO_DATABASE" ]]; then
    quarantine_active_database failed-deployment || die "could not quarantine the failed deployment database"
  else
    ETP_DEPLOY_LOCK_HELD=1 "${LIBEXEC_DIR}/restore-sqlite.sh" "$database_before" --leave-stopped >/dev/null
  fi
fi

caddy_changed=1
"${LIBEXEC_DIR}/restore-caddy-state.sh" "$release_id"

if [[ "$service_was_active" == "1" && "$previous_target" != "NONE" ]]; then
  /usr/bin/systemctl start "$SERVICE_NAME"
  healthy=0
  for _ in {1..30}; do
    if /usr/bin/curl --fail --silent --show-error --max-time 2 "$HEALTH_URL" >/dev/null; then
      healthy=1
      break
    fi
    /usr/bin/sleep 1
  done
  [[ "$healthy" -eq 1 ]] || die "previous release was restored but its API health check failed"
else
  /usr/bin/systemctl stop "$SERVICE_NAME" >/dev/null 2>&1 || true
fi

/usr/bin/install -m 0600 -o root -g root /dev/null "${attempt_dir}/rollback-succeeded"
rollback_committed=1
trap - EXIT HUP INT TERM
rollback_complete_temp="$(/usr/bin/mktemp "${state_dir}/.rollback-complete.XXXXXX")"
/usr/bin/chown root:root "$rollback_complete_temp"
/usr/bin/chmod 0600 "$rollback_complete_temp"
/usr/bin/mv -Tf -- "$rollback_complete_temp" "${state_dir}/rollback-complete"
log "release ${release_id} rolled back transactionally; recovery state is in ${attempt_dir}"

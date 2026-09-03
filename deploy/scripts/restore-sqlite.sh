#!/usr/bin/env bash
set -euo pipefail

readonly DATA_DIR="/var/lib/english-typing-practice"
readonly DATABASE_PATH="${DATA_DIR}/app.db"
readonly BACKUP_ROOT="/var/backups/english-typing-practice"
readonly QUARANTINE_ROOT="${BACKUP_ROOT}/restore-quarantine"
readonly LOCK_PATH="/var/lib/english-typing-practice-locks/database.lock"
readonly DEPLOY_LOCK="/var/lib/english-typing-practice-locks/deploy.lock"
readonly SERVICE_NAME="englishapp.service"
readonly HEALTH_URL="http://127.0.0.1:8091/api/healthz"

log() {
  printf '[englishapp-restore] %s\n' "$*" >&2
}

die() {
  log "ERROR: $*"
  exit 1
}

[[ "${EUID}" -eq 0 ]] || die "run this script as root"
[[ $# -ge 1 && $# -le 2 ]] || die "usage: restore-sqlite.sh <backup.sqlite3> [--leave-stopped]"
readonly requested_backup="$1"
readonly start_mode="${2:-}"
[[ -z "$start_mode" || "$start_mode" == "--leave-stopped" ]] || die "unknown option: ${start_mode}"

for command_path in /usr/bin/sqlite3 /usr/bin/realpath /usr/bin/systemctl /usr/bin/curl /usr/bin/flock /usr/bin/mktemp; do
  [[ -x "$command_path" ]] || die "required command is missing: ${command_path}"
done
for fixed_dir in "$DATA_DIR" "$BACKUP_ROOT" "$QUARANTINE_ROOT"; do
  [[ -d "$fixed_dir" && ! -L "$fixed_dir" ]] || die "unsafe fixed directory: ${fixed_dir}"
done

# A standalone restore participates in the deployment lock. Rollback already owns it.
if [[ "${ETP_DEPLOY_LOCK_HELD:-0}" != "1" ]]; then
  [[ -f "$DEPLOY_LOCK" && ! -L "$DEPLOY_LOCK" ]] || die "deployment lock is missing or unsafe"
  exec 8>"$DEPLOY_LOCK"
  /usr/bin/flock -w 60 8 || die "timed out waiting for the deployment lock"
fi
[[ -f "$LOCK_PATH" && ! -L "$LOCK_PATH" ]] || die "database lock is missing or unsafe"
exec 9>"$LOCK_PATH"
/usr/bin/flock -w 60 9 || die "timed out waiting for the database maintenance lock"

validate_backup() {
  local candidate="$1"
  local canonical basename
  [[ "$candidate" == /* ]] || die "backup path must be absolute"
  [[ -f "$candidate" && ! -L "$candidate" ]] || die "backup must be a regular, non-symlink file"
  canonical="$(/usr/bin/realpath -e -- "$candidate")"
  [[ "$canonical" == "$candidate" ]] || die "backup path must already be canonical"
  case "$canonical" in
    "${BACKUP_ROOT}"/daily/*.sqlite3|"${BACKUP_ROOT}"/weekly/*.sqlite3|"${BACKUP_ROOT}"/pre-migration/*.sqlite3|"${BACKUP_ROOT}"/pre-restore/*.sqlite3) ;;
    *) die "backup must be a regular file in an approved backup class" ;;
  esac
  basename="$(/usr/bin/basename -- "$canonical")"
  [[ "$basename" =~ ^(daily|weekly|pre-migration|pre-restore)-[0-9]{8}T[0-9]{6}\.[0-9]{9}Z\.sqlite3$ ]] ||
    die "backup filename does not match the managed format"
  printf '%s\n' "$canonical"
}

# First validation is already under both locks.
readonly backup_path="$(validate_backup "$requested_backup")"
readonly source_identity="$(/usr/bin/stat -Lc '%d:%i:%s:%Y' "$backup_path")"
readonly source_integrity="$(/usr/bin/sqlite3 -readonly "$backup_path" 'PRAGMA integrity_check;' 2>&1)"
[[ "$source_integrity" == "ok" ]] || die "source backup failed integrity check: ${source_integrity}"

readonly stamp="$(/usr/bin/date -u +%Y%m%dT%H%M%S.%NZ)"
readonly quarantine_dir="$(/usr/bin/mktemp -d "${QUARANTINE_ROOT}/${stamp}.XXXXXX")"
/usr/bin/chown root:root "$quarantine_dir"
/usr/bin/chmod 0700 "$quarantine_dir"
restored_temp=""
if /usr/bin/systemctl is-active --quiet "$SERVICE_NAME"; then
  service_was_active=1
else
  service_was_active=0
fi
printf '%s\n' "$service_was_active" >"${quarantine_dir}/service-was-active"
printf '%s\n' "$backup_path" >"${quarantine_dir}/restore-source"
/usr/bin/chown root:root "${quarantine_dir}/service-was-active" "${quarantine_dir}/restore-source"
/usr/bin/chmod 0600 "${quarantine_dir}/service-was-active" "${quarantine_dir}/restore-source"

mutation_started=0
new_database_installed=0
restore_committed=0

reinstate_previous_database() {
  /usr/bin/systemctl stop "$SERVICE_NAME" >/dev/null 2>&1 || true
  if [[ "$new_database_installed" -eq 1 && -e "$DATABASE_PATH" ]]; then
    if [[ -f "$DATABASE_PATH" && ! -L "$DATABASE_PATH" ]]; then
      /usr/bin/mv -f -- "$DATABASE_PATH" "${quarantine_dir}/app.db.failed-restore" || return 1
    else
      log "CRITICAL: refusing to move an unexpected database path during recovery"
      return 1
    fi
  fi
  for suffix in -wal -shm; do
    if [[ "$new_database_installed" -eq 1 && -f "${DATABASE_PATH}${suffix}" && ! -L "${DATABASE_PATH}${suffix}" ]]; then
      /usr/bin/mv -f -- "${DATABASE_PATH}${suffix}" "${quarantine_dir}/app.db${suffix}.failed-restore" || return 1
    fi
  done
  if [[ -f "${quarantine_dir}/app.db.before-restore" ]]; then
    /usr/bin/mv -- "${quarantine_dir}/app.db.before-restore" "$DATABASE_PATH" || return 1
    for suffix in -wal -shm; do
      [[ ! -f "${quarantine_dir}/app.db${suffix}.before-restore" ]] ||
        /usr/bin/mv -- "${quarantine_dir}/app.db${suffix}.before-restore" "${DATABASE_PATH}${suffix}" || return 1
    done
  fi
}

cleanup() {
  [[ -z "$restored_temp" || ! -e "$restored_temp" ]] || /usr/bin/rm -f -- "$restored_temp"
}

on_exit() {
  local status=$?
  trap - EXIT HUP INT TERM
  cleanup || true
  if [[ "$status" -ne 0 && "$restore_committed" -eq 0 ]]; then
    if [[ "$mutation_started" -eq 1 ]]; then
      log "restore failed or was interrupted; reinstating the pre-restore database"
      reinstate_previous_database || log "CRITICAL: database recovery needs operator attention"
    fi
    if [[ "$service_was_active" -eq 1 ]]; then
      /usr/bin/systemctl start "$SERVICE_NAME" || log "CRITICAL: prior service could not be restarted"
    else
      /usr/bin/systemctl stop "$SERVICE_NAME" >/dev/null 2>&1 || true
    fi
  fi
  exit "$status"
}
trap on_exit EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

/usr/bin/systemctl stop "$SERVICE_NAME"

# Re-resolve, re-identify, and re-check after stop while locks remain held.
readonly locked_backup_path="$(validate_backup "$requested_backup")"
[[ "$locked_backup_path" == "$backup_path" ]] || die "backup target changed while restore was preparing"
[[ "$(/usr/bin/stat -Lc '%d:%i:%s:%Y' "$locked_backup_path")" == "$source_identity" ]] ||
  die "backup identity changed while restore was preparing"
readonly locked_integrity="$(/usr/bin/sqlite3 -readonly "$locked_backup_path" 'PRAGMA integrity_check;' 2>&1)"
[[ "$locked_integrity" == "ok" ]] || die "locked source backup failed integrity check: ${locked_integrity}"

# -readonly guarantees that copying cannot create WAL/journal state beside the source backup.
restored_temp="$(/usr/bin/mktemp "${DATA_DIR}/.app.db.restore.${stamp}.XXXXXX")"
/usr/bin/chmod 0600 "$restored_temp"
/usr/bin/sqlite3 -readonly "$locked_backup_path" ".backup '${restored_temp}'"
readonly restored_integrity="$(/usr/bin/sqlite3 -readonly "$restored_temp" 'PRAGMA integrity_check;' 2>&1)"
[[ "$restored_integrity" == "ok" ]] || die "restored copy failed integrity check: ${restored_integrity}"
/usr/bin/chown englishapp:englishapp "$restored_temp"
/usr/bin/chmod 0600 "$restored_temp"

mutation_started=1
if [[ -e "$DATABASE_PATH" ]]; then
  [[ -f "$DATABASE_PATH" && ! -L "$DATABASE_PATH" ]] || die "database must be a regular, non-symlink file"
  /usr/bin/mv -- "$DATABASE_PATH" "${quarantine_dir}/app.db.before-restore"
fi
for suffix in -wal -shm; do
  sidecar="${DATABASE_PATH}${suffix}"
  if [[ -e "$sidecar" ]]; then
    [[ -f "$sidecar" && ! -L "$sidecar" ]] || die "unexpected SQLite sidecar type: ${sidecar}"
    /usr/bin/mv -- "$sidecar" "${quarantine_dir}/app.db${suffix}.before-restore"
  fi
done
/usr/bin/mv -T -- "$restored_temp" "$DATABASE_PATH"
new_database_installed=1

if [[ "$start_mode" != "--leave-stopped" ]]; then
  /usr/bin/systemctl start "$SERVICE_NAME"
  healthy=0
  for _ in {1..30}; do
    if /usr/bin/curl --fail --silent --show-error --max-time 2 "$HEALTH_URL" >/dev/null; then
      healthy=1
      break
    fi
    /usr/bin/sleep 1
  done
  [[ "$healthy" -eq 1 ]] || die "restored database did not pass the API health check"
fi

/usr/bin/install -m 0600 -o root -g root /dev/null "${quarantine_dir}/restore-complete"
restore_committed=1
trap - EXIT HUP INT TERM
cleanup
log "restore complete; displaced files are preserved in ${quarantine_dir}"
printf '%s\n' "$quarantine_dir"

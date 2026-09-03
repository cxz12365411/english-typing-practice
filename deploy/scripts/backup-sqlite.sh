#!/usr/bin/env bash
set -euo pipefail

readonly DATA_DIR="/var/lib/english-typing-practice"
readonly DATABASE_PATH="${DATA_DIR}/app.db"
readonly BACKUP_ROOT="/var/backups/english-typing-practice"
readonly LOCK_PATH="/var/lib/english-typing-practice-locks/database.lock"
readonly DEPLOYMENT_ROOT="/var/lib/english-typing-practice-deployments"

log() {
  printf '[englishapp-backup] %s\n' "$*" >&2
}

die() {
  log "ERROR: $*"
  exit 1
}

[[ $# -eq 1 ]] || die "usage: backup-sqlite.sh <daily|weekly|pre-migration|pre-restore>"
readonly backup_class="$1"

case "$backup_class" in
  daily) readonly retention=7 ;;
  weekly) readonly retention=4 ;;
  pre-migration|pre-restore) readonly retention=10 ;;
  *) die "unsupported backup class: ${backup_class}" ;;
esac

[[ -x /usr/bin/sqlite3 && -x /usr/bin/mktemp ]] || die "sqlite3 and mktemp are required"
[[ -d "$DATA_DIR" && ! -L "$DATA_DIR" ]] || die "invalid data directory: ${DATA_DIR}"
[[ -d "$BACKUP_ROOT" && ! -L "$BACKUP_ROOT" ]] || die "invalid backup root: ${BACKUP_ROOT}"

readonly backup_dir="${BACKUP_ROOT}/${backup_class}"
[[ -d "$backup_dir" && ! -L "$backup_dir" ]] || die "invalid backup directory: ${backup_dir}"

[[ -f "$LOCK_PATH" && ! -L "$LOCK_PATH" ]] || die "database lock is missing or unsafe"
exec 9>"$LOCK_PATH"
/usr/bin/flock -w 60 9 || die "timed out waiting for the database maintenance lock"

if [[ ! -e "$DATABASE_PATH" ]]; then
  log "database does not exist yet; nothing to back up"
  printf 'NO_DATABASE\n'
  exit 0
fi
[[ -f "$DATABASE_PATH" && ! -L "$DATABASE_PATH" ]] || die "database must be a regular, non-symlink file"

readonly stamp="$(/usr/bin/date -u +%Y%m%dT%H%M%S.%NZ)"
readonly filename="${backup_class}-${stamp}.sqlite3"
readonly destination="${backup_dir}/${filename}"
readonly temporary="$(/usr/bin/mktemp "${backup_dir}/.${filename}.tmp.XXXXXX")"

cleanup() {
  [[ ! -e "$temporary" ]] || /usr/bin/rm -f -- "$temporary"
}
trap cleanup EXIT

/usr/bin/sqlite3 "$DATABASE_PATH" ".timeout 30000" ".backup '${temporary}'"
readonly integrity="$(/usr/bin/sqlite3 -readonly "$temporary" 'PRAGMA integrity_check;' 2>&1)"
[[ "$integrity" == "ok" ]] || die "backup integrity check failed: ${integrity}"
[[ ! -e "$destination" ]] || die "refusing to overwrite existing backup: ${destination}"
/usr/bin/mv -T -- "$temporary" "$destination"
/usr/bin/chmod 0600 "$destination"

mapfile -t backups < <(
  /usr/bin/find "$backup_dir" -maxdepth 1 -type f -name "${backup_class}-*.sqlite3" -printf '%f\n' |
    LC_ALL=C /usr/bin/sort -r
)

for ((index = retention; index < ${#backups[@]}; index++)); do
  candidate="${backups[$index]}"
  [[ "$candidate" =~ ^${backup_class}-[0-9]{8}T[0-9]{6}\.[0-9]{9}Z\.sqlite3$ ]] ||
    die "refusing to rotate unexpected filename: ${candidate}"
  candidate_path="${backup_dir}/${candidate}"
  referenced=0
  if [[ ( "$backup_class" == "pre-migration" || "$backup_class" == "pre-restore" ) && -d "$DEPLOYMENT_ROOT" && ! -L "$DEPLOYMENT_ROOT" ]]; then
    while IFS= read -r state_pointer; do
      if /usr/bin/grep -Fqx -- "$candidate_path" "$state_pointer"; then
        referenced=1
        break
      fi
    done < <(/usr/bin/find "$DEPLOYMENT_ROOT" -type f \( -name database-before -o -name rollback-entry-database \) -print)
  fi
  if [[ "$referenced" -eq 1 ]]; then
    log "retaining deployment-referenced snapshot ${candidate}"
    continue
  fi
  /usr/bin/rm -f -- "$candidate_path"
done

trap - EXIT
printf '%s\n' "$destination"

#!/usr/bin/env bash
set -euo pipefail

readonly APP_ROOT="/opt/english-typing-practice"
readonly BUILD_ROOT="/var/tmp/english-typing-practice/build"
readonly BUILD_HOME="/var/cache/english-typing-practice-build"
readonly DATA_DIR="/var/lib/english-typing-practice"
readonly DEPLOYMENT_ROOT="/var/lib/english-typing-practice-deployments"
readonly LOCK_ROOT="/var/lib/english-typing-practice-locks"
readonly DATABASE_LOCK="${LOCK_ROOT}/database.lock"
readonly DEPLOY_LOCK="${LOCK_ROOT}/deploy.lock"
readonly BACKUP_ROOT="/var/backups/english-typing-practice"
readonly CONFIG_DIR="/etc/english-typing-practice"
readonly ENV_FILE="${CONFIG_DIR}/env"
readonly LIBEXEC_DIR="/usr/local/libexec/english-typing-practice"
readonly SHARE_DIR="/usr/local/share/english-typing-practice"
readonly SYSTEMD_DIR="/etc/systemd/system"
readonly CADDY_LOG_DIR="/var/log/caddy"
readonly APP_USER="englishapp"
readonly APP_GROUP="englishapp"
readonly BUILD_USER="englishbuild"
readonly BUILD_GROUP="englishbuild"
readonly WEB_USER="caddy"
readonly WEB_GROUP="caddy"

readonly SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && /bin/pwd -P)"
readonly DEPLOY_DIR="$(cd -- "${SCRIPT_DIR}/.." && /bin/pwd -P)"

log() {
  printf '[englishapp-provision] %s\n' "$*" >&2
}

die() {
  log "ERROR: $*"
  exit 1
}

[[ "${EUID}" -eq 0 ]] || die "run this script as root"

for command_path in /usr/bin/node /usr/bin/sqlite3 /usr/bin/curl /usr/bin/python3 /usr/bin/systemctl /usr/bin/systemd-analyze /usr/bin/openssl /usr/bin/mktemp /usr/bin/sed /usr/sbin/useradd; do
  [[ -x "$command_path" ]] || die "required command is missing: ${command_path}"
done
[[ -x /usr/bin/caddy ]] || die "/usr/bin/caddy is required"

readonly node_major="$(/usr/bin/node -p 'process.versions.node.split(".")[0]')"
[[ "$node_major" == "22" ]] || die "Node.js 22 is required; found $(/usr/bin/node --version)"

for source_file in \
  "${DEPLOY_DIR}/env.example" \
  "${DEPLOY_DIR}/README.md" \
  "${DEPLOY_DIR}/caddy/english-typing-practice.caddy" \
  "${DEPLOY_DIR}/systemd/englishapp.service" \
  "${DEPLOY_DIR}/systemd/englishapp-backup@.service" \
  "${DEPLOY_DIR}/systemd/englishapp-backup-daily.timer" \
  "${DEPLOY_DIR}/systemd/englishapp-backup-weekly.timer" \
  "${SCRIPT_DIR}/backup-sqlite.sh" \
  "${SCRIPT_DIR}/restore-sqlite.sh" \
  "${SCRIPT_DIR}/activate-caddy-site.sh" \
  "${SCRIPT_DIR}/restore-caddy-state.sh" \
  "${SCRIPT_DIR}/robot-regression.sh" \
  "${SCRIPT_DIR}/prune-deployments.sh" \
  "${SCRIPT_DIR}/rewrite-caddy.py" \
  "${SCRIPT_DIR}/stage-release.sh" \
  "${SCRIPT_DIR}/deploy-release.sh" \
  "${SCRIPT_DIR}/rollback-release.sh" \
  "${SCRIPT_DIR}/acceptance-test.sh"; do
  [[ -f "$source_file" && ! -L "$source_file" ]] || die "missing deployment asset: ${source_file}"
done

if ! /usr/bin/getent passwd "$APP_USER" >/dev/null; then
  /usr/sbin/useradd --system --user-group --home-dir "$DATA_DIR" --shell /usr/sbin/nologin "$APP_USER"
fi
[[ "$(/usr/bin/id -gn "$APP_USER")" == "$APP_GROUP" ]] || die "${APP_USER} must use primary group ${APP_GROUP}"
if ! /usr/bin/getent passwd "$BUILD_USER" >/dev/null; then
  /usr/sbin/useradd --system --user-group --home-dir "$BUILD_HOME" --create-home --shell /usr/sbin/nologin "$BUILD_USER"
fi
[[ "$(/usr/bin/id -gn "$BUILD_USER")" == "$BUILD_GROUP" ]] || die "${BUILD_USER} must use primary group ${BUILD_GROUP}"
/usr/bin/getent passwd "$WEB_USER" >/dev/null || die "the Caddy account ${WEB_USER} is missing"
[[ "$(/usr/bin/id -gn "$WEB_USER")" == "$WEB_GROUP" ]] || die "${WEB_USER} must use primary group ${WEB_GROUP}"
[[ " $(/usr/bin/id -nG "$WEB_USER") " != *" ${APP_GROUP} "* ]] || die "Caddy must not belong to the API runtime group"
[[ " $(/usr/bin/id -nG "$APP_USER") " != *" ${WEB_GROUP} "* ]] || die "the API runtime must not belong to the Caddy group"

for managed_dir in \
  "$DATA_DIR" "$DEPLOYMENT_ROOT" "$LOCK_ROOT" "$APP_ROOT" "${APP_ROOT}/releases" \
  /var/tmp/english-typing-practice /var/tmp/english-typing-practice/incoming "$BUILD_ROOT" \
  "$BUILD_HOME" "${BUILD_HOME}/.npm" "$BACKUP_ROOT" "$CONFIG_DIR" "$LIBEXEC_DIR" "$SHARE_DIR" "$CADDY_LOG_DIR"; do
  [[ ! -L "$managed_dir" ]] || die "managed directory must not be a symlink: ${managed_dir}"
  [[ ! -e "$managed_dir" || -d "$managed_dir" ]] || die "managed path is not a directory: ${managed_dir}"
done
for backup_class in daily weekly pre-migration pre-restore restore-quarantine failed-deployments host-config; do
  managed_dir="${BACKUP_ROOT}/${backup_class}"
  [[ ! -L "$managed_dir" ]] || die "managed backup directory must not be a symlink: ${managed_dir}"
  [[ ! -e "$managed_dir" || -d "$managed_dir" ]] || die "managed backup path is not a directory: ${managed_dir}"
done

/usr/bin/install -d -m 0750 -o "$APP_USER" -g "$APP_GROUP" "$DATA_DIR"
/usr/bin/install -d -m 0700 -o root -g root "$DEPLOYMENT_ROOT"
/usr/bin/install -d -m 0750 -o root -g "$APP_GROUP" "$LOCK_ROOT"
/usr/bin/install -d -m 0755 -o root -g root "$APP_ROOT" "${APP_ROOT}/releases"
/usr/bin/install -d -m 0711 -o root -g root /var/tmp/english-typing-practice "$BUILD_ROOT"
/usr/bin/install -d -m 0700 -o root -g root /var/tmp/english-typing-practice/incoming
/usr/bin/install -d -m 0700 -o "$BUILD_USER" -g "$BUILD_GROUP" "$BUILD_HOME" "${BUILD_HOME}/.npm"
/usr/bin/install -d -m 0750 -o root -g "$APP_GROUP" "$BACKUP_ROOT"
for backup_class in daily weekly; do
  /usr/bin/install -d -m 0700 -o "$APP_USER" -g "$APP_GROUP" "${BACKUP_ROOT}/${backup_class}"
done
for backup_class in pre-migration pre-restore restore-quarantine failed-deployments; do
  /usr/bin/install -d -m 0700 -o root -g root "${BACKUP_ROOT}/${backup_class}"
done
/usr/bin/install -d -m 0750 -o root -g "$APP_GROUP" "$CONFIG_DIR"
/usr/bin/install -d -m 0755 -o root -g root "$LIBEXEC_DIR" "$SHARE_DIR"
/usr/bin/install -d -m 0750 -o caddy -g caddy "$CADDY_LOG_DIR"
for lock_path in "$DATABASE_LOCK" "$DEPLOY_LOCK"; do
  if [[ ! -e "$lock_path" ]]; then
    /usr/bin/install -m 0600 -o root -g root /dev/null "$lock_path"
  else
    [[ -f "$lock_path" && ! -L "$lock_path" ]] || die "lock path must be a regular, non-symlink file: ${lock_path}"
  fi
done
/usr/bin/chown root:"$APP_GROUP" "$DATABASE_LOCK"
/usr/bin/chmod 0660 "$DATABASE_LOCK"
/usr/bin/chown root:root "$DEPLOY_LOCK"
/usr/bin/chmod 0600 "$DEPLOY_LOCK"

readonly config_backup_dir="${BACKUP_ROOT}/host-config"
/usr/bin/install -d -m 0700 -o root -g root "$config_backup_dir"
readonly stamp="$(/usr/bin/date -u +%Y%m%dT%H%M%S.%NZ)"

install_managed() {
  local source_path="$1"
  local target_path="$2"
  local mode="$3"
  local backup_name
  if [[ -L "$target_path" || ( -e "$target_path" && ! -f "$target_path" ) ]]; then
    die "refusing to replace a non-regular managed path: ${target_path}"
  fi
  if [[ -f "$target_path" ]] && ! /usr/bin/cmp -s -- "$source_path" "$target_path"; then
    backup_name="$(printf '%s' "$target_path" | /usr/bin/tr '/' '_')"
    /usr/bin/install -m 0600 -o root -g root "$target_path" "${config_backup_dir}/${backup_name}.${stamp}"
  fi
  /usr/bin/install -m "$mode" -o root -g root "$source_path" "$target_path"
}

for script_name in backup-sqlite.sh restore-sqlite.sh activate-caddy-site.sh restore-caddy-state.sh robot-regression.sh prune-deployments.sh stage-release.sh deploy-release.sh rollback-release.sh acceptance-test.sh; do
  install_managed "${SCRIPT_DIR}/${script_name}" "${LIBEXEC_DIR}/${script_name}" 0755
done
install_managed "${SCRIPT_DIR}/rewrite-caddy.py" "${LIBEXEC_DIR}/rewrite-caddy.py" 0755
install_managed "${DEPLOY_DIR}/caddy/english-typing-practice.caddy" "${SHARE_DIR}/caddy-site.caddy" 0644
install_managed "${DEPLOY_DIR}/README.md" "${SHARE_DIR}/README.md" 0644

for unit_name in englishapp.service englishapp-backup@.service englishapp-backup-daily.timer englishapp-backup-weekly.timer; do
  install_managed "${DEPLOY_DIR}/systemd/${unit_name}" "${SYSTEMD_DIR}/${unit_name}" 0644
done

if [[ ! -e "$ENV_FILE" ]]; then
  /usr/bin/install -m 0640 -o root -g "$APP_GROUP" "${DEPLOY_DIR}/env.example" "$ENV_FILE"
else
  [[ -f "$ENV_FILE" && ! -L "$ENV_FILE" ]] || die "environment file must be a regular, non-symlink file"
  if /usr/bin/grep -Fqx 'TRUST_PROXY=true' "$ENV_FILE"; then
    [[ "$(/usr/bin/grep -Ec '^TRUST_PROXY=' "$ENV_FILE" || true)" == "1" ]] || die "environment contains duplicate TRUST_PROXY values"
    /usr/bin/install -m 0600 -o root -g root "$ENV_FILE" "${config_backup_dir}/env.before-loopback-migration.${stamp}"
    env_temp="$(/usr/bin/mktemp "${CONFIG_DIR}/.env.loopback.XXXXXX")"
    if ! /usr/bin/sed 's/^TRUST_PROXY=true$/TRUST_PROXY=loopback/' "$ENV_FILE" >"$env_temp"; then
      /usr/bin/rm -f -- "$env_temp"
      die "failed to migrate the legacy TRUST_PROXY value"
    fi
    /usr/bin/chown root:"$APP_GROUP" "$env_temp"
    /usr/bin/chmod 0640 "$env_temp"
    if ! /usr/bin/mv -Tf -- "$env_temp" "$ENV_FILE"; then
      /usr/bin/rm -f -- "$env_temp"
      die "failed to atomically install the migrated environment"
    fi
    log "migrated legacy TRUST_PROXY=true to the loopback-only trust policy"
  fi
  /usr/bin/chown root:"$APP_GROUP" "$ENV_FILE"
  /usr/bin/chmod 0640 "$ENV_FILE"
fi

guest_secret_count="$(/usr/bin/grep -Ec '^GUEST_TOKEN_SECRET=' "$ENV_FILE" || true)"
if [[ "$guest_secret_count" == "0" ]] || /usr/bin/grep -Fqx 'GUEST_TOKEN_SECRET=__GENERATED_BY_PROVISION_HOST__' "$ENV_FILE"; then
  [[ "$guest_secret_count" == "0" || "$guest_secret_count" == "1" ]] || die "environment contains duplicate GUEST_TOKEN_SECRET values"
  /usr/bin/install -m 0600 -o root -g root "$ENV_FILE" "${config_backup_dir}/env.before-guest-secret.${stamp}"
  env_temp="$(/usr/bin/mktemp "${CONFIG_DIR}/.env.guest-secret.XXXXXX")"
  /usr/bin/grep -Ev '^GUEST_TOKEN_SECRET=' "$ENV_FILE" >"$env_temp"
  printf 'GUEST_TOKEN_SECRET=%s\n' "$(/usr/bin/openssl rand -hex 32)" >>"$env_temp"
  /usr/bin/chown root:"$APP_GROUP" "$env_temp"
  /usr/bin/chmod 0640 "$env_temp"
  /usr/bin/mv -Tf -- "$env_temp" "$ENV_FILE"
  log "generated a persistent guest CSRF signing secret"
elif [[ "$guest_secret_count" != "1" ]]; then
  die "environment must define GUEST_TOKEN_SECRET exactly once"
fi
guest_secret_value="$(/usr/bin/sed -n 's/^GUEST_TOKEN_SECRET=//p' "$ENV_FILE")"
[[ "${#guest_secret_value}" -ge 32 ]] || die "GUEST_TOKEN_SECRET must contain at least 32 characters"

/usr/bin/systemd-analyze verify \
  "${SYSTEMD_DIR}/englishapp.service" \
  "${SYSTEMD_DIR}/englishapp-backup@.service" \
  "${SYSTEMD_DIR}/englishapp-backup-daily.timer" \
  "${SYSTEMD_DIR}/englishapp-backup-weekly.timer"
/usr/bin/systemctl daemon-reload
/usr/bin/systemctl enable englishapp.service
/usr/bin/systemctl enable --now englishapp-backup-daily.timer englishapp-backup-weekly.timer

log "host provisioning complete"
log "the active Caddyfile and legacy static site were not changed"

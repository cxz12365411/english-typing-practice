#!/usr/bin/env bash
set -euo pipefail

readonly APP_ROOT="/opt/english-typing-practice"
readonly RELEASE_ROOT="${APP_ROOT}/releases"
readonly CURRENT_LINK="${APP_ROOT}/current"
readonly INCOMING_ROOT="/var/tmp/english-typing-practice/incoming"
readonly DATA_DIR="/var/lib/english-typing-practice"
readonly DATABASE_PATH="${DATA_DIR}/app.db"
readonly DEPLOYMENT_ROOT="/var/lib/english-typing-practice-deployments"
readonly ENV_FILE="/etc/english-typing-practice/env"
readonly SERVICE_NAME="englishapp.service"
readonly HEALTH_URL="http://127.0.0.1:8091/api/healthz"
readonly LIBEXEC_DIR="/usr/local/libexec/english-typing-practice"
readonly DEPLOY_LOCK="/var/lib/english-typing-practice-locks/deploy.lock"
readonly ADMIN_RUNTIME_DIR="/run/english-typing-practice"
readonly ADMIN_PASSWORD_FILE="${ADMIN_RUNTIME_DIR}/initial-admin-password"
readonly ROBOT_BASELINE_NAME="robot-baseline.json"

log() {
  printf '[englishapp-deploy] %s\n' "$*" >&2
}

die() {
  log "ERROR: $*"
  exit 1
}

[[ "${EUID}" -eq 0 ]] || die "run this script as root"
[[ $# -eq 1 ]] || die "usage: deploy-release.sh <release-id>"
readonly release_id="$1"
[[ "$release_id" =~ ^[0-9a-f]{7,64}$ ]] || die "release id must be a 7-64 character lowercase hexadecimal Git commit"

readonly incoming="${INCOMING_ROOT}/${release_id}"
readonly release_dir="${RELEASE_ROOT}/${release_id}"
readonly staging_dir="${RELEASE_ROOT}/.staging-${release_id}-$$"
readonly state_dir="${DEPLOYMENT_ROOT}/${release_id}"
readonly pending_link="${APP_ROOT}/.current-${release_id}-$$"
readonly ADMIN_STATE_PASSWORD_FILE="${state_dir}/initial-admin-password.recovery"

for command_path in /usr/bin/node /usr/bin/sqlite3 /usr/bin/curl /usr/bin/flock /usr/bin/realpath /usr/bin/systemctl /usr/bin/openssl; do
  [[ -x "$command_path" ]] || die "required command is missing: ${command_path}"
done
readonly RUNUSER="$(command -v runuser || true)"
[[ -n "$RUNUSER" && -x "$RUNUSER" ]] || die "runuser is required (normally /usr/sbin/runuser)"
for helper in backup-sqlite.sh rollback-release.sh activate-caddy-site.sh robot-regression.sh prune-deployments.sh acceptance-test.sh; do
  [[ -x "${LIBEXEC_DIR}/${helper}" ]] || die "deployment helper is missing: ${LIBEXEC_DIR}/${helper}"
done

[[ -f "$DEPLOY_LOCK" && ! -L "$DEPLOY_LOCK" ]] || die "deployment lock is missing or unsafe"
exec 9>"$DEPLOY_LOCK"
/usr/bin/flock -n 9 || die "another deployment or rollback is already running"

[[ -d "$APP_ROOT" && ! -L "$APP_ROOT" ]] || die "invalid application root: ${APP_ROOT}"
[[ -d "$RELEASE_ROOT" && ! -L "$RELEASE_ROOT" ]] || die "invalid release root: ${RELEASE_ROOT}"
[[ -d "$DEPLOYMENT_ROOT" && ! -L "$DEPLOYMENT_ROOT" ]] || die "invalid deployment state root: ${DEPLOYMENT_ROOT}"
[[ -d "$incoming" && ! -L "$incoming" ]] || die "incoming release directory is missing or unsafe: ${incoming}"
[[ "$(/usr/bin/realpath -e -- "$incoming")" == "$incoming" ]] || die "incoming release must resolve to its canonical fixed path"
[[ ! -e "$release_dir" && ! -e "$staging_dir" && ! -e "$state_dir" ]] || die "release or deployment state already exists; refusing to overwrite"
[[ ! -e "$pending_link" ]] || die "unexpected pending current link exists"
[[ -f "$ENV_FILE" && ! -L "$ENV_FILE" ]] || die "environment file must be a regular, non-symlink file"
[[ "$(/usr/bin/stat -c '%U:%G:%a' "$ENV_FILE")" == "root:englishapp:640" ]] ||
  die "environment file must be root:englishapp mode 0640"

require_env_value() {
  local key="$1"
  local expected="$2"
  local count
  count="$(/usr/bin/grep -Ec "^${key}=" "$ENV_FILE" || true)"
  [[ "$count" == "1" ]] || die "environment must define ${key} exactly once"
  /usr/bin/grep -Fqx "${key}=${expected}" "$ENV_FILE" || die "${key} must equal ${expected}"
}
require_env_value HOST 127.0.0.1
require_env_value PORT 8091
require_env_value DATABASE_PATH "$DATABASE_PATH"
require_env_value APP_ORIGIN https://english-47-120-37-63.sslip.io
require_env_value TRUST_PROXY loopback
guest_secret_count="$(/usr/bin/grep -Ec '^GUEST_TOKEN_SECRET=' "$ENV_FILE" || true)"
[[ "$guest_secret_count" == "1" ]] || die "environment must define GUEST_TOKEN_SECRET exactly once"
guest_secret_value="$(/usr/bin/sed -n 's/^GUEST_TOKEN_SECRET=//p' "$ENV_FILE")"
[[ "${#guest_secret_value}" -ge 32 && "$guest_secret_value" != '__GENERATED_BY_PROVISION_HOST__' ]] ||
  die "GUEST_TOKEN_SECRET must be a generated secret of at least 32 characters"

for required_path in \
  server/dist/index.js \
  server/dist/scripts/migrate.js \
  server/dist/scripts/bootstrap-admin.js \
  server/node_modules \
  server/package.json \
  web/dist/index.html \
  web/dist/manifest.webmanifest \
  web/dist/sw.js \
  basic-english-850.md \
  daily-english-high-frequency-sentences.md \
  release.json; do
  [[ -e "${incoming}/${required_path}" ]] || die "incoming release is missing ${required_path}"
done
[[ -f "${incoming}/release.json" && ! -L "${incoming}/release.json" ]] || die "release.json must be a regular file"
/usr/bin/node -e '
  const fs = require("node:fs");
  const manifest = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  if (manifest.commit !== process.argv[2]) process.exit(2);
' "${incoming}/release.json" "$release_id" || die "release.json commit does not match release id"

if /usr/bin/find "$incoming" -xdev \( -type b -o -type c -o -type p \) -print -quit | /usr/bin/grep -q .; then
  die "incoming release contains a device, FIFO, or socket"
fi
if /usr/bin/find "$incoming" -xdev -type f \( -name '.env' -o -name '*.db' -o -name '*.sqlite' -o -name '*.sqlite3' -o -name '*.pem' -o -name '*.key' \) -print -quit | /usr/bin/grep -q .; then
  die "incoming release contains a secret or persistent-data filename"
fi

while IFS= read -r -d '' link_path; do
  link_value="$(/usr/bin/readlink -- "$link_path")"
  [[ "$link_value" != /* ]] || die "incoming release contains an absolute symlink: ${link_path}"
  resolved_link="$(/usr/bin/realpath -m -- "$(/usr/bin/dirname -- "$link_path")/${link_value}")"
  case "$resolved_link" in
    "${incoming}"/*) ;;
    *) die "incoming release symlink escapes its version directory: ${link_path}" ;;
  esac
done < <(/usr/bin/find "$incoming" -xdev -type l -print0)

cleanup_staging() {
  if [[ -d "$staging_dir" && ! -L "$staging_dir" ]]; then
    /usr/bin/find "$staging_dir" -depth -mindepth 1 -delete
    /usr/bin/rmdir "$staging_dir"
  fi
  [[ ! -e "$pending_link" ]] || /usr/bin/rm -f -- "$pending_link"
  [[ ! -e "$ADMIN_PASSWORD_FILE" ]] || /usr/bin/shred -u -- "$ADMIN_PASSWORD_FILE" 2>/dev/null || /usr/bin/rm -f -- "$ADMIN_PASSWORD_FILE"
}
rollback_armed=0
restart_old_service_armed=0
deployment_committed=0
prior_service_active=0
on_exit() {
  local status=$?
  local rollback_succeeded=0
  trap - EXIT HUP INT TERM
  cleanup_staging || true
  if [[ "$status" -ne 0 && "$rollback_armed" -eq 1 ]]; then
    log "deployment failed; invoking protected automatic rollback"
    if ETP_DEPLOY_LOCK_HELD=1 "${LIBEXEC_DIR}/rollback-release.sh" "$release_id" --automatic; then
      rollback_succeeded=1
    else
      log "CRITICAL: automatic rollback needs operator attention"
    fi
  elif [[ "$status" -ne 0 && "$restart_old_service_armed" -eq 1 && "$prior_service_active" -eq 1 ]]; then
    log "deployment stopped before a rollback snapshot existed; restarting the unchanged old API"
    /usr/bin/systemctl start "$SERVICE_NAME" || log "CRITICAL: old API could not be restarted"
  fi
  if [[ -f "$ADMIN_STATE_PASSWORD_FILE" ]]; then
    if [[ "$rollback_succeeded" -eq 1 ]]; then
      /usr/bin/shred -u -- "$ADMIN_STATE_PASSWORD_FILE" 2>/dev/null || /usr/bin/rm -f -- "$ADMIN_STATE_PASSWORD_FILE"
    else
      log "initial administrator recovery credential remains root-only at ${ADMIN_STATE_PASSWORD_FILE}"
    fi
  fi
  exit "$status"
}
trap on_exit EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

/usr/bin/install -d -m 0755 -o root -g root "$staging_dir"
/usr/bin/install -d -m 0750 -o root -g englishapp "$staging_dir/server"
/usr/bin/install -d -m 0750 -o root -g caddy "$staging_dir/web"
/usr/bin/cp -a -- "${incoming}/server/dist" "$staging_dir/server/dist"
/usr/bin/cp -a -- "${incoming}/server/node_modules" "$staging_dir/server/node_modules"
/usr/bin/install -m 0640 -o root -g englishapp "${incoming}/server/package.json" "$staging_dir/server/package.json"
/usr/bin/cp -a -- "${incoming}/web/dist" "$staging_dir/web/dist"
/usr/bin/install -m 0640 -o root -g englishapp "${incoming}/basic-english-850.md" "$staging_dir/basic-english-850.md"
/usr/bin/install -m 0640 -o root -g englishapp "${incoming}/daily-english-high-frequency-sentences.md" "$staging_dir/daily-english-high-frequency-sentences.md"
/usr/bin/install -m 0600 -o root -g root "${incoming}/release.json" "$staging_dir/release.json"

while IFS= read -r -d '' link_path; do
  link_value="$(/usr/bin/readlink -- "$link_path")"
  [[ "$link_value" != /* ]] || die "release contains an absolute symlink: ${link_path}"
  resolved_link="$(/usr/bin/realpath -m -- "$(/usr/bin/dirname -- "$link_path")/${link_value}")"
  case "$resolved_link" in
    "${staging_dir}"/*) ;;
    *) die "release symlink escapes its version directory: ${link_path}" ;;
  esac
done < <(/usr/bin/find "$staging_dir" -type l -print0)

/usr/bin/chown root:root "$staging_dir"
/usr/bin/chmod 0755 "$staging_dir"
/usr/bin/chown -R root:englishapp "$staging_dir/server"
/usr/bin/find "$staging_dir/server" -type d -exec /usr/bin/chmod 0750 {} +
/usr/bin/find "$staging_dir/server" -type f -exec /usr/bin/chmod 0640 {} +
/usr/bin/chown -R root:caddy "$staging_dir/web"
/usr/bin/find "$staging_dir/web" -type d -exec /usr/bin/chmod 0750 {} +
/usr/bin/find "$staging_dir/web" -type f -exec /usr/bin/chmod 0640 {} +
/usr/bin/chown root:englishapp "$staging_dir/basic-english-850.md" "$staging_dir/daily-english-high-frequency-sentences.md"
/usr/bin/chmod 0640 "$staging_dir/basic-english-850.md" "$staging_dir/daily-english-high-frequency-sentences.md"
/usr/bin/mv -T -- "$staging_dir" "$release_dir"

# Verify effective identities, not just numeric modes, before the release can become current.
"$RUNUSER" --user englishapp -- /usr/bin/test -r "${release_dir}/server/dist/index.js" || die "API account cannot read server release"
if "$RUNUSER" --user englishapp -- /usr/bin/test -r "${release_dir}/web/dist/index.html"; then
  die "API account unexpectedly reads Caddy-only Web assets"
fi
"$RUNUSER" --user caddy -- /usr/bin/test -r "${release_dir}/web/dist/index.html" || die "Caddy cannot traverse/read the Web release"
if "$RUNUSER" --user caddy -- /usr/bin/test -r "${release_dir}/server/dist/index.js"; then
  die "Caddy unexpectedly reads API server code"
fi
if "$RUNUSER" --user caddy -- /usr/bin/test -r "$ENV_FILE"; then
  die "Caddy unexpectedly reads the application environment"
fi
if "$RUNUSER" --user caddy -- /usr/bin/test -x "$DATA_DIR"; then
  die "Caddy unexpectedly traverses persistent application data"
fi

/usr/bin/install -d -m 0700 -o root -g root "$state_dir"
printf '%s\n' "$release_dir" >"${state_dir}/new-target"
if [[ -e "$CURRENT_LINK" ]]; then
  [[ -L "$CURRENT_LINK" ]] || die "current must be a symlink; refusing to replace a real path"
  previous_target="$(/usr/bin/realpath -e -- "$CURRENT_LINK")"
  case "$previous_target" in
    "${RELEASE_ROOT}"/[0-9a-f]*) ;;
    *) die "current points outside the fixed releases directory: ${previous_target}" ;;
  esac
  [[ -d "$previous_target" && ! -L "$previous_target" ]] || die "previous release target is invalid"
  printf '%s\n' "$previous_target" >"${state_dir}/previous-target"
else
  printf 'NONE\n' >"${state_dir}/previous-target"
fi
if /usr/bin/systemctl is-active --quiet "$SERVICE_NAME"; then
  prior_service_active=1
else
  prior_service_active=0
fi
printf '%s\n' "$prior_service_active" >"${state_dir}/service-was-active"
/usr/bin/chmod 0600 "${state_dir}/"*

"${LIBEXEC_DIR}/robot-regression.sh" capture "${state_dir}/${ROBOT_BASELINE_NAME}"
# Arm restart-only recovery before stopping. The old database is not mutated until a
# post-stop snapshot is complete, so failures before that point only restart the old API.
restart_old_service_armed=1
/usr/bin/systemctl stop "$SERVICE_NAME"
# Snapshot only after writers are stopped; this is the exact rollback point.
database_backup="$("${LIBEXEC_DIR}/backup-sqlite.sh" pre-migration)"
printf '%s\n' "$database_backup" >"${state_dir}/database-before"
/usr/bin/chmod 0600 "${state_dir}/database-before"
rollback_armed=1
restart_old_service_armed=0

"$RUNUSER" --user englishapp -- /bin/bash -c '
  set -euo pipefail
  umask 0077
  set -a
  source /etc/english-typing-practice/env
  set +a
  cd "$1"
  exec /usr/bin/node dist/scripts/migrate.js
' englishapp-migrate "${release_dir}/server"
/usr/bin/chown englishapp:englishapp "$DATABASE_PATH"
/usr/bin/chmod 0600 "$DATABASE_PATH"
[[ "$(/usr/bin/stat -c '%U:%G:%a' "$DATABASE_PATH")" == "englishapp:englishapp:600" ]] ||
  die "database ownership or mode is not englishapp:englishapp 0600"

initial_admin_password=""
active_admin_count="$(/usr/bin/sqlite3 -readonly "$DATABASE_PATH" "SELECT count(*) FROM users WHERE role = 'admin' AND active = 1;")"
[[ "$active_admin_count" =~ ^[0-9]+$ ]] || die "could not determine active administrator count"
if [[ "$active_admin_count" -eq 0 ]]; then
  /usr/bin/install -d -m 0750 -o root -g englishapp "$ADMIN_RUNTIME_DIR"
  initial_admin_password="$(/usr/bin/openssl rand -base64 15)"
  [[ "${#initial_admin_password}" -eq 20 ]] || die "failed to generate a 20-character temporary password"
  (umask 0077; printf '%s\n' "$initial_admin_password" >"$ADMIN_STATE_PASSWORD_FILE")
  /usr/bin/chown root:root "$ADMIN_STATE_PASSWORD_FILE"
  /usr/bin/chmod 0600 "$ADMIN_STATE_PASSWORD_FILE"
  /usr/bin/install -m 0640 -o root -g englishapp "$ADMIN_STATE_PASSWORD_FILE" "$ADMIN_PASSWORD_FILE"
  "$RUNUSER" --user englishapp -- /bin/bash -c '
    set -euo pipefail
    set -a
    source /etc/english-typing-practice/env
    set +a
    cd "$1"
    exec /usr/bin/node dist/scripts/bootstrap-admin.js --username admin --password-file /run/english-typing-practice/initial-admin-password
  ' englishapp-bootstrap "${release_dir}/server"
  /usr/bin/shred -u -- "$ADMIN_PASSWORD_FILE" 2>/dev/null || /usr/bin/rm -f -- "$ADMIN_PASSWORD_FILE"
  active_admin_count="$(/usr/bin/sqlite3 -readonly "$DATABASE_PATH" "SELECT count(*) FROM users WHERE role = 'admin' AND active = 1;")"
  [[ "$active_admin_count" -ge 1 ]] || die "bootstrap command did not create an active administrator"
fi

/usr/bin/ln -s -- "releases/${release_id}" "$pending_link"
/usr/bin/mv -Tf -- "$pending_link" "$CURRENT_LINK"
/usr/bin/systemctl start "$SERVICE_NAME"

healthy=0
for _ in {1..30}; do
  if /usr/bin/curl --fail --silent --show-error --max-time 2 "$HEALTH_URL" >/dev/null; then
    healthy=1
    break
  fi
  /usr/bin/sleep 1
done
[[ "$healthy" -eq 1 ]] || die "new API did not become ready at ${HEALTH_URL}"

"${LIBEXEC_DIR}/activate-caddy-site.sh" "$release_id"
if [[ -n "$initial_admin_password" ]]; then
  ETP_ROBOT_BASELINE_FILE="${state_dir}/${ROBOT_BASELINE_NAME}" \
  ETP_TEST_USERNAME=admin \
  ETP_TEST_PASSWORD="$initial_admin_password" \
  ETP_EXPECT_ROLE=admin \
  ETP_EXPECT_MUST_CHANGE=true \
    "${LIBEXEC_DIR}/acceptance-test.sh"
else
  ETP_ROBOT_BASELINE_FILE="${state_dir}/${ROBOT_BASELINE_NAME}" \
    "${LIBEXEC_DIR}/acceptance-test.sh"
fi

/usr/bin/install -m 0600 -o root -g root /dev/null "${state_dir}/deployed-success"
rollback_armed=0
deployment_committed=1

log "release ${release_id} deployed successfully"
if [[ -n "$initial_admin_password" ]]; then
  printf 'INITIAL_ADMIN_USERNAME=admin\n'
  printf 'INITIAL_ADMIN_TEMP_PASSWORD=%s\n' "$initial_admin_password"
  printf 'INITIAL_ADMIN_MUST_CHANGE_PASSWORD=true\n'
  /usr/bin/shred -u -- "$ADMIN_STATE_PASSWORD_FILE" 2>/dev/null || /usr/bin/rm -f -- "$ADMIN_STATE_PASSWORD_FILE" ||
    log "WARNING: delivered credential remains in root-only deployment state"
fi
cleanup_staging || log "WARNING: temporary staging cleanup needs operator attention"

# A staged archive is single-use. Old terminal releases/states are pruned only after
# the new version, credentials, and robot invariants have all passed.
if [[ "$deployment_committed" -eq 1 ]]; then
  if [[ "$(/usr/bin/realpath -e -- "$incoming" 2>/dev/null || true)" == "$incoming" && ! -L "$incoming" ]]; then
    if ! /usr/bin/find "$incoming" -xdev -depth -mindepth 1 -delete || ! /usr/bin/rmdir -- "$incoming"; then
      log "WARNING: deployed incoming archive could not be fully removed: ${incoming}"
    fi
  else
    log "WARNING: refusing non-canonical incoming cleanup target: ${incoming}"
  fi
  if ! ETP_DEPLOY_LOCK_HELD=1 "${LIBEXEC_DIR}/prune-deployments.sh"; then
    log "WARNING: retention cleanup failed; live release and recovery state were kept"
  fi
fi
trap - EXIT HUP INT TERM

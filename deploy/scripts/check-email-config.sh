#!/usr/bin/env bash
set -euo pipefail

# Validate the protected production email settings and, unless --config-only is
# requested, verify the SMTP TLS/authentication handshake without sending mail.
# Secrets are loaded only after dropping to englishapp and are never passed as
# command-line arguments or written to output.

readonly ENV_FILE="/etc/english-typing-practice/env"
readonly CURRENT_SERVER="/opt/english-typing-practice/current/server"
readonly DATABASE_PATH="/var/lib/english-typing-practice/app.db"
readonly APP_USER="englishapp"
readonly -a EMAIL_ENV_KEYS=(
  NODE_ENV EMAIL_DELIVERY EMAIL_CODE_SECRET EMAIL_SELF_REGISTRATION EMAIL_DAILY_SEND_LIMIT
  EMAIL_REGISTRATION_DAILY_SEND_LIMIT EMAIL_REGISTRATION_IP_DAILY_LIMIT
  SMTP_HOST SMTP_PORT SMTP_USERNAME SMTP_PASSWORD
  EMAIL_FROM EMAIL_FROM_NAME
)

log() {
  printf '[englishapp-email-check] %s\n' "$*" >&2
}

die() {
  log "ERROR: $*"
  exit 1
}

usage() {
  printf 'usage: check-email-config.sh [--config-only]\n' >&2
}

trim_value() {
  local value="$1"
  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"
  printf '%s' "$value"
}

readonly requested_action="${1:---smtp}"
if [[ "$requested_action" != "--config-only" && "$requested_action" != "--smtp" ]]; then
  usage
  exit 2
fi
[[ $# -le 1 ]] || { usage; exit 2; }

if [[ "${ETP_EMAIL_CHECK_DELEGATED:-0}" != "1" ]]; then
  [[ "${EUID}" -eq 0 ]] || die "run this script as root"
  [[ -f "$ENV_FILE" && ! -L "$ENV_FILE" ]] || die "environment file must be a regular, non-symlink file"
  [[ "$(/usr/bin/stat -c '%U:%G:%a' "$ENV_FILE")" == "root:englishapp:640" ]] ||
    die "environment file must be root:englishapp mode 0640"
  readonly RUNUSER="$(command -v runuser || true)"
  [[ -n "$RUNUSER" && -x "$RUNUSER" ]] || die "runuser is required (normally /usr/sbin/runuser)"

  # Reject duplicates before sourcing so the last occurrence can never silently
  # override a reviewed setting. Empty SMTP values are allowed only while disabled.
  for key in "${EMAIL_ENV_KEYS[@]}"; do
    count="$(/usr/bin/grep -Ec "^${key}=" "$ENV_FILE" || true)"
    [[ "$count" == "1" ]] || die "environment must define ${key} exactly once"
  done

  exec "$RUNUSER" --user "$APP_USER" -- /usr/bin/env -i \
    ETP_EMAIL_CHECK_DELEGATED=1 \
    HOME="/var/lib/english-typing-practice" \
    PATH="/usr/bin:/bin" \
    "$0" "$requested_action"
fi

[[ "$(/usr/bin/id -un)" == "$APP_USER" ]] || die "delegated validation must run as ${APP_USER}"
[[ -r "$ENV_FILE" ]] || die "application account cannot read the protected environment"
set +x
# Parse fixed key=value records without shell evaluation. This preserves literal
# SMTP password characters and prevents a configuration value from becoming code.
load_env_value() {
  local key="$1"
  local line value
  line="$(/usr/bin/grep -E "^${key}=" "$ENV_FILE")"
  value="${line#*=}"
  [[ "$value" != *$'\r'* && "$value" != *$'\n'* ]] || die "${key} contains a line break"
  printf -v "$key" '%s' "$value"
  export "$key"
}
for key in "${EMAIL_ENV_KEYS[@]}"; do
  load_env_value "$key"
done
for key in "${EMAIL_ENV_KEYS[@]}"; do
  value="${!key}"
  [[ "$value" == "$(trim_value "$value")" ]] || die "${key} must not have leading or trailing whitespace"
  [[ "$value" != *\\* && "$value" != *\"* && "$value" != *\'* ]] ||
    die "${key} must be an unquoted literal without backslashes or quote characters"
done

[[ "${NODE_ENV:-}" == "production" ]] || die "NODE_ENV must equal production"
delivery="$(trim_value "${EMAIL_DELIVERY:-}")"
delivery="${delivery,,}"
[[ "$delivery" == "disabled" || "$delivery" == "smtp" ]] ||
  die "production EMAIL_DELIVERY must be disabled or smtp; test is forbidden"

[[ "${#EMAIL_CODE_SECRET}" -ge 32 && "$EMAIL_CODE_SECRET" != "__GENERATED_BY_PROVISION_HOST__" ]] ||
  die "EMAIL_CODE_SECRET must be a generated secret of at least 32 characters"
self_registration="$(trim_value "${EMAIL_SELF_REGISTRATION:-}")"
self_registration="${self_registration,,}"
[[ "$self_registration" == "true" || "$self_registration" == "false" ]] ||
  die "EMAIL_SELF_REGISTRATION must be true or false"
daily_send_limit_value="$(trim_value "${EMAIL_DAILY_SEND_LIMIT:-}")"
[[ "$daily_send_limit_value" =~ ^[0-9]+$ ]] || die "EMAIL_DAILY_SEND_LIMIT must be an integer"
daily_send_limit=$((10#${daily_send_limit_value}))
(( daily_send_limit >= 1 && daily_send_limit <= 10000 )) ||
  die "EMAIL_DAILY_SEND_LIMIT must be between 1 and 10000"
registration_daily_send_limit_value="$(trim_value "${EMAIL_REGISTRATION_DAILY_SEND_LIMIT:-}")"
[[ "$registration_daily_send_limit_value" =~ ^[0-9]+$ ]] ||
  die "EMAIL_REGISTRATION_DAILY_SEND_LIMIT must be an integer"
registration_daily_send_limit=$((10#${registration_daily_send_limit_value}))
(( registration_daily_send_limit >= 1 && registration_daily_send_limit <= daily_send_limit )) ||
  die "EMAIL_REGISTRATION_DAILY_SEND_LIMIT must be between 1 and EMAIL_DAILY_SEND_LIMIT"
registration_ip_daily_limit_value="$(trim_value "${EMAIL_REGISTRATION_IP_DAILY_LIMIT:-}")"
[[ "$registration_ip_daily_limit_value" =~ ^[0-9]+$ ]] ||
  die "EMAIL_REGISTRATION_IP_DAILY_LIMIT must be an integer"
registration_ip_daily_limit=$((10#${registration_ip_daily_limit_value}))
(( registration_ip_daily_limit >= 1 && registration_ip_daily_limit <= registration_daily_send_limit )) ||
  die "EMAIL_REGISTRATION_IP_DAILY_LIMIT must be between 1 and EMAIL_REGISTRATION_DAILY_SEND_LIMIT"

if [[ "$delivery" == "disabled" ]]; then
  [[ "$self_registration" == "false" ]] ||
    die "EMAIL_SELF_REGISTRATION must remain false while email delivery is disabled"
  log "production email configuration is valid (delivery disabled)"
  exit 0
fi

for variable_name in SMTP_HOST SMTP_PORT SMTP_USERNAME SMTP_PASSWORD EMAIL_FROM; do
  [[ -n "${!variable_name:-}" ]] || die "${variable_name} is required when EMAIL_DELIVERY=smtp"
done
smtp_host="$(trim_value "$SMTP_HOST")"
smtp_port="$(trim_value "$SMTP_PORT")"
smtp_username="$(trim_value "$SMTP_USERNAME")"
email_from="$(trim_value "$EMAIL_FROM")"
[[ -n "$smtp_host" && "$smtp_host" != *[[:space:]]* ]] || die "SMTP_HOST must be a plain hostname"
[[ "$smtp_port" == "465" ]] || die "SMTP_PORT must equal 465 for implicit TLS"
[[ "${smtp_username,,}" == "${email_from,,}" ]] ||
  die "EMAIL_FROM must equal SMTP_USERNAME for authenticated sender delivery"
[[ "${EMAIL_FROM_NAME:-}" != *[[:cntrl:]]* ]] ||
  die "EMAIL_FROM_NAME must not contain control characters"
if ! /usr/bin/python3 <<'PY'
import os
import re
import sys

email = os.environ.get("SMTP_USERNAME", "").strip().lower()
if not (3 <= len(email) <= 254):
    sys.exit(1)
parts = email.split("@")
if len(parts) != 2:
    sys.exit(1)
local, domain = parts
if not (1 <= len(local) <= 64) or local.startswith(".") or local.endswith(".") or ".." in local:
    sys.exit(1)
if not re.fullmatch(r"[a-z0-9.!#$%&'*+/=?^_`{|}~-]+", local, re.I):
    sys.exit(1)
labels = domain.split(".")
if len(labels) < 2 or len(domain) > 253:
    sys.exit(1)
if any(not re.fullmatch(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?", label, re.I) for label in labels):
    sys.exit(1)
PY
then
  die "SMTP_USERNAME and EMAIL_FROM must be plain valid email addresses"
fi

if [[ "$self_registration" == "true" ]]; then
  [[ -f "$DATABASE_PATH" && ! -L "$DATABASE_PATH" ]] ||
    die "self-registration requires the existing application database"
  active_verified_admins="$(/usr/bin/sqlite3 -readonly "$DATABASE_PATH" \
    "SELECT count(*) FROM users WHERE role = 'admin' AND active = 1 AND email IS NOT NULL AND email_verified_at IS NOT NULL;" \
    2>/dev/null || true)"
  [[ "$active_verified_admins" =~ ^[0-9]+$ && "$active_verified_admins" -ge 1 ]] ||
    die "bind and verify an active administrator email before enabling self-registration"
fi

log "production email configuration is valid (SMTP, implicit TLS on port 465)"
[[ "$requested_action" == "--smtp" ]] || exit 0
[[ -d "$CURRENT_SERVER" && ! -L "$CURRENT_SERVER" ]] || die "current server release is missing or unsafe"
[[ -d "${CURRENT_SERVER}/node_modules/nodemailer" ]] || die "nodemailer is missing from the current server release"

cd "$CURRENT_SERVER"
if ! /usr/bin/node <<'NODE'
const nodemailer = require("nodemailer");
const transport = nodemailer.createTransport({
  host: process.env.SMTP_HOST.trim(),
  port: 465,
  secure: true,
  auth: { user: process.env.SMTP_USERNAME.trim(), pass: process.env.SMTP_PASSWORD },
  tls: { minVersion: "TLSv1.2", servername: process.env.SMTP_HOST.trim() },
  connectionTimeout: 10_000,
  greetingTimeout: 10_000,
  socketTimeout: 20_000,
  logger: false,
  debug: false
});

transport.verify().then(
  () => {
    transport.close();
    process.exit(0);
  },
  () => {
    transport.close();
    process.exit(1);
  }
);
NODE
then
  die "SMTP TLS/authentication preflight failed; credentials were not printed"
fi
log "SMTP TLS/authentication preflight passed; no email was sent"

#!/usr/bin/env bash
set -euo pipefail

readonly BASE_URL="https://english-47-120-37-63.sslip.io"
readonly HTTP_URL="http://english-47-120-37-63.sslip.io"
readonly ROBOT_URL="https://robot-47-120-37-63.sslip.io"
readonly ROBOT_LOCAL_URL="http://127.0.0.1:8080/"
readonly LOCAL_HEALTH_URL="http://127.0.0.1:8091/api/healthz"
readonly ROBOT_CHECKER="/usr/local/libexec/english-typing-practice/robot-regression.sh"

log() {
  printf '[englishapp-acceptance] %s\n' "$*" >&2
}

die() {
  log "ERROR: $*"
  exit 1
}

for command_path in /usr/bin/curl /usr/bin/python3 /usr/bin/mktemp; do
  [[ -x "$command_path" ]] || die "required command is missing: ${command_path}"
done

readonly test_username="${ETP_TEST_USERNAME:-}"
readonly test_password="${ETP_TEST_PASSWORD:-}"
readonly expected_role="${ETP_EXPECT_ROLE:-}"
readonly expected_must_change="${ETP_EXPECT_MUST_CHANGE:-}"
readonly robot_baseline="${ETP_ROBOT_BASELINE_FILE:-}"
if [[ -n "$test_username" || -n "$test_password" ]]; then
  [[ -n "$test_username" && -n "$test_password" ]] || die "set both ETP_TEST_USERNAME and ETP_TEST_PASSWORD"
fi
[[ -z "$expected_role" || "$expected_role" == "user" || "$expected_role" == "admin" ]] || die "ETP_EXPECT_ROLE must be user or admin"
[[ -z "$expected_must_change" || "$expected_must_change" == "true" || "$expected_must_change" == "false" ]] || die "ETP_EXPECT_MUST_CHANGE must be true or false"
if [[ -n "$expected_role" || -n "$expected_must_change" ]]; then
  [[ -n "$test_username" ]] || die "credential expectations require test credentials"
fi

readonly temp_dir="$(/usr/bin/mktemp -d /tmp/englishapp-acceptance.XXXXXX)"
cleanup() {
  /usr/bin/find "$temp_dir" -mindepth 1 -maxdepth 1 -type f -delete
  /usr/bin/rmdir "$temp_dir"
}
trap cleanup EXIT

curl_status() {
  /usr/bin/curl --silent --show-error --max-time 15 --output "$2" --dump-header "$3" --write-out '%{http_code}' "$1"
}

assert_status() {
  local actual="$1"
  local expected="$2"
  local label="$3"
  [[ "$actual" == "$expected" ]] || die "${label}: expected HTTP ${expected}, got ${actual}"
}

/usr/bin/curl --fail --silent --show-error --max-time 5 "$LOCAL_HEALTH_URL" >"${temp_dir}/local-health.json"

ready=0
for _ in {1..30}; do
  if /usr/bin/curl --fail --silent --show-error --max-time 5 "${BASE_URL}/api/healthz" >"${temp_dir}/public-health.json"; then
    ready=1
    break
  fi
  /usr/bin/sleep 2
done
[[ "$ready" -eq 1 ]] || die "public HTTPS health endpoint did not become ready"

for route in / /login /practice /admin; do
  safe_name="$(printf '%s' "$route" | /usr/bin/tr '/' '_')"
  status="$(curl_status "${BASE_URL}${route}" "${temp_dir}/${safe_name}.body" "${temp_dir}/${safe_name}.headers")"
  assert_status "$status" 200 "SPA route ${route}"
  /usr/bin/grep -Eiq '^content-type:[[:space:]]*text/html' "${temp_dir}/${safe_name}.headers" || die "${route} is not HTML"
done

for asset in /manifest.webmanifest /sw.js; do
  safe_name="$(printf '%s' "$asset" | /usr/bin/tr '/' '_')"
  status="$(curl_status "${BASE_URL}${asset}" "${temp_dir}/${safe_name}.body" "${temp_dir}/${safe_name}.headers")"
  assert_status "$status" 200 "PWA asset ${asset}"
done
/usr/bin/grep -Eiq '^content-type:[[:space:]]*application/manifest\+json' "${temp_dir}/_manifest.webmanifest.headers" ||
  die "PWA manifest has an invalid content type"

status="$(curl_status "${BASE_URL}/" "${temp_dir}/security.body" "${temp_dir}/security.headers")"
assert_status "$status" 200 "HTTPS root"
/usr/bin/grep -Eiq '^content-security-policy:' "${temp_dir}/security.headers" || die "missing Content-Security-Policy"
/usr/bin/grep -Eiq '^x-content-type-options:[[:space:]]*nosniff' "${temp_dir}/security.headers" || die "missing nosniff header"
/usr/bin/grep -Eiq '^x-frame-options:[[:space:]]*DENY' "${temp_dir}/security.headers" || die "missing frame protection"
/usr/bin/grep -Eiq '^cache-control:[[:space:]]*no-store' "${temp_dir}/security.headers" || die "HTML must not be cached"

http_status="$(/usr/bin/curl --silent --show-error --max-time 10 --output /dev/null --dump-header "${temp_dir}/redirect.headers" --write-out '%{http_code}' "$HTTP_URL/")"
[[ "$http_status" =~ ^30[1278]$ ]] || die "HTTP did not redirect to HTTPS (status ${http_status})"
/usr/bin/grep -Eiq '^location:[[:space:]]*https://english-47-120-37-63\.sslip\.io/' "${temp_dir}/redirect.headers" || die "redirect target is not the canonical HTTPS origin"

status="$(/usr/bin/curl --silent --show-error --max-time 15 \
  --cookie-jar "${temp_dir}/guest-cookies.txt" \
  --output "${temp_dir}/anonymous-session.body" \
  --dump-header "${temp_dir}/anonymous-session.headers" \
  --write-out '%{http_code}' \
  "${BASE_URL}/api/auth/session")"
assert_status "$status" 200 "anonymous CSRF session"
/usr/bin/python3 -c '
import json, sys
payload = json.load(open(sys.argv[1], encoding="utf-8"))
assert payload.get("user") is None, "anonymous session unexpectedly contains a user"
token = payload.get("csrfToken")
assert isinstance(token, str) and len(token) >= 32, "anonymous session has no usable CSRF token"
' "${temp_dir}/anonymous-session.body" || die "anonymous CSRF session payload is invalid"
guest_csrf_token="$(/usr/bin/python3 -c 'import json,sys; print(json.load(open(sys.argv[1], encoding="utf-8"))["csrfToken"])' "${temp_dir}/anonymous-session.body")"
guest_cookie_header="$(/usr/bin/grep -Ei '^set-cookie:[[:space:]]*__Host-etp_session=' "${temp_dir}/anonymous-session.headers" || true)"
[[ -n "$guest_cookie_header" ]] || die "guest CSRF bootstrap did not set the opaque session cookie"
for cookie_attribute in 'Path=/' 'HttpOnly' 'Secure' 'SameSite=Lax'; do
  [[ "$guest_cookie_header" == *"${cookie_attribute}"* ]] || die "guest session cookie is missing ${cookie_attribute}"
done

status="$(/usr/bin/curl --silent --show-error --max-time 15 \
  --cookie "${temp_dir}/guest-cookies.txt" \
  --output "${temp_dir}/anonymous-admin.body" \
  --dump-header "${temp_dir}/anonymous-admin.headers" \
  --write-out '%{http_code}' \
  "${BASE_URL}/api/admin/stats")"
assert_status "$status" 401 "anonymous admin access"

robot_status="$(/usr/bin/curl --silent --show-error --max-time 15 --output "${temp_dir}/robot.body" --write-out '%{http_code}' "$ROBOT_URL/")"
[[ "$robot_status" =~ ^[23][0-9]{2}$ ]] || die "robot site regression check failed (HTTP ${robot_status})"
robot_local_status="$(/usr/bin/curl --silent --show-error --max-time 15 --header 'Host: robot-47-120-37-63.sslip.io' --output "${temp_dir}/robot-local.body" --write-out '%{http_code}' "$ROBOT_LOCAL_URL")"
[[ "$robot_local_status" =~ ^2[0-9]{2}$ ]] || die "robot service on 127.0.0.1:8080 failed (HTTP ${robot_local_status})"
if [[ -n "$robot_baseline" ]]; then
  [[ -x "$ROBOT_CHECKER" ]] || die "robot regression checker is missing"
  "$ROBOT_CHECKER" check "$robot_baseline"
fi

if [[ -n "$test_username" ]]; then
  /usr/bin/python3 -c '
import json, sys
username = sys.stdin.readline().rstrip("\n")
password = sys.stdin.readline().rstrip("\n")
json.dump({"username": username, "password": password}, sys.stdout)
' >"${temp_dir}/login.json" <<<"${test_username}"$'\n'"${test_password}"
  /usr/bin/chmod 0600 "${temp_dir}/login.json"

  login_status="$(/usr/bin/curl --silent --show-error --max-time 15 \
    --request POST \
    --header 'Content-Type: application/json' \
    --header "Origin: ${BASE_URL}" \
    --header "X-CSRF-Token: ${guest_csrf_token}" \
    --data-binary "@${temp_dir}/login.json" \
    --cookie "${temp_dir}/guest-cookies.txt" \
    --cookie-jar "${temp_dir}/cookies.txt" \
    --dump-header "${temp_dir}/login.headers" \
    --output "${temp_dir}/login.body" \
    --write-out '%{http_code}' \
    "${BASE_URL}/api/auth/login")"
  assert_status "$login_status" 200 "credentialed login"
  cookie_header="$(/usr/bin/grep -Ei '^set-cookie:[[:space:]]*__Host-etp_session=' "${temp_dir}/login.headers" || true)"
  [[ -n "$cookie_header" ]] || die "login did not set the __Host-etp_session cookie"
  for cookie_attribute in 'Path=/' 'HttpOnly' 'Secure' 'SameSite=Lax'; do
    [[ "$cookie_header" == *"${cookie_attribute}"* ]] || die "session cookie is missing ${cookie_attribute}"
  done

  csrf_token="$(/usr/bin/python3 -c 'import json,sys; print(json.load(open(sys.argv[1], encoding="utf-8"))["csrfToken"])' "${temp_dir}/login.body")"
  [[ -n "$csrf_token" ]] || die "login response did not contain a CSRF token"
  /usr/bin/python3 - "$expected_role" "$expected_must_change" "${temp_dir}/login.body" <<'PY'
import json
import sys

expected_role, expected_must_change, path = sys.argv[1:]
with open(path, encoding="utf-8") as handle:
    payload = json.load(handle)
user = payload.get("user")
assert isinstance(user, dict), "login response has no user"
if expected_role:
    assert user.get("role") == expected_role, f"expected role {expected_role}, got {user.get('role')}"
if expected_must_change:
    expected = expected_must_change == "true"
    assert user.get("mustChangePassword") is expected, "unexpected mustChangePassword value"
PY

  session_status="$(/usr/bin/curl --silent --show-error --max-time 15 \
    --cookie "${temp_dir}/cookies.txt" --output "${temp_dir}/session.body" --write-out '%{http_code}' \
    "${BASE_URL}/api/auth/session")"
  assert_status "$session_status" 200 "authenticated session"

  content_status="$(/usr/bin/curl --silent --show-error --max-time 30 \
    --cookie "${temp_dir}/cookies.txt" --output "${temp_dir}/content.body" --write-out '%{http_code}' \
    "${BASE_URL}/api/content")"
  if [[ "$expected_must_change" == "true" ]]; then
    assert_status "$content_status" 403 "temporary-password content gate"
    /usr/bin/python3 -c '
import json, sys
payload = json.load(open(sys.argv[1], encoding="utf-8"))
assert payload.get("error", {}).get("code") == "MUST_CHANGE_PASSWORD"
' "${temp_dir}/content.body" || die "temporary-password account was not correctly gated"
  else
    assert_status "$content_status" 200 "published content"
    /usr/bin/python3 -c '
import json, sys
payload = json.load(open(sys.argv[1], encoding="utf-8"))
assert len(payload["categories"]) == 18, "expected 18 categories, got %d" % len(payload["categories"])
assert len(payload["items"]) == 1018, "expected 1018 items, got %d" % len(payload["items"])
' "${temp_dir}/content.body" || die "published content count check failed"
  fi

  logout_status="$(/usr/bin/curl --silent --show-error --max-time 15 \
    --request POST \
    --header "Origin: ${BASE_URL}" \
    --header "X-CSRF-Token: ${csrf_token}" \
    --cookie "${temp_dir}/cookies.txt" \
    --output "${temp_dir}/logout.body" --write-out '%{http_code}' \
    "${BASE_URL}/api/auth/logout")"
  assert_status "$logout_status" 200 "logout"
  /usr/bin/python3 -c '
import json, sys
payload = json.load(open(sys.argv[1], encoding="utf-8"))
assert payload == {"ok": True}, "logout response was not {ok:true}"
' "${temp_dir}/logout.body" || die "logout response payload is invalid"
  after_logout_status="$(/usr/bin/curl --silent --show-error --max-time 15 \
    --cookie "${temp_dir}/cookies.txt" --output "${temp_dir}/after-logout.body" --write-out '%{http_code}' \
    "${BASE_URL}/api/auth/session")"
  assert_status "$after_logout_status" 200 "post-logout guest session"
  /usr/bin/python3 -c '
import json, sys
payload = json.load(open(sys.argv[1], encoding="utf-8"))
assert payload.get("user") is None, "logged-out session still contains a user"
' "${temp_dir}/after-logout.body" || die "logout did not revoke the authenticated session"
fi

trap - EXIT
cleanup
log "production acceptance checks passed"

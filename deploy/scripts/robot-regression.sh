#!/usr/bin/env bash
set -euo pipefail

readonly ROBOT_URL="https://robot-47-120-37-63.sslip.io/"
readonly ROBOT_LOCAL_URL="http://127.0.0.1:8080/"
readonly ROBOT_HOST="robot-47-120-37-63.sslip.io"
readonly DEPLOYMENT_ROOT="/var/lib/english-typing-practice-deployments"

log() {
  printf '[englishapp-robot] %s\n' "$*" >&2
}

die() {
  log "ERROR: $*"
  exit 1
}

[[ "${EUID}" -eq 0 ]] || die "run this script as root"
[[ $# -eq 2 ]] || die "usage: robot-regression.sh <capture|check> <deployment-baseline.json>"
readonly action="$1"
readonly requested_baseline="$2"
[[ "$action" == "capture" || "$action" == "check" ]] || die "action must be capture or check"

for command_path in /usr/bin/curl /usr/bin/python3 /usr/bin/realpath /usr/bin/sha256sum /usr/bin/mktemp; do
  [[ -x "$command_path" ]] || die "required command is missing: ${command_path}"
done

readonly baseline_parent="$(/usr/bin/realpath -e -- "$(/usr/bin/dirname -- "$requested_baseline")")"
readonly baseline_state_id="$(/usr/bin/basename -- "$baseline_parent")"
[[ "$baseline_state_id" =~ ^[0-9a-f]{7,64}$ ]] || die "baseline state directory name is invalid"
[[ "$(/usr/bin/dirname -- "$baseline_parent")" == "$DEPLOYMENT_ROOT" ]] || die "baseline must be stored directly in a deployment state directory"
[[ "$(/usr/bin/basename -- "$requested_baseline")" == "robot-baseline.json" ]] || die "unexpected robot baseline filename"
readonly baseline_path="${baseline_parent}/robot-baseline.json"
[[ ! -L "$baseline_path" ]] || die "robot baseline must not be a symlink"

readonly temp_dir="$(/usr/bin/mktemp -d /tmp/englishapp-robot.XXXXXX)"
cleanup() {
  /usr/bin/find "$temp_dir" -xdev -depth -mindepth 1 -delete
  /usr/bin/rmdir "$temp_dir"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

capture_endpoint() {
  local label="$1"
  local url="$2"
  shift 2
  local status
  status="$(/usr/bin/curl --location --silent --show-error --max-time 20 \
    --output "${temp_dir}/${label}.body" --write-out '%{http_code}' "$@" "$url")"
  [[ "$status" =~ ^2[0-9]{2}$ ]] || die "${label} robot endpoint returned HTTP ${status}"
  printf '%s\n' "$status" >"${temp_dir}/${label}.status"
}

capture_endpoint public "$ROBOT_URL"
capture_endpoint local "$ROBOT_LOCAL_URL" --header "Host: ${ROBOT_HOST}"

readonly snapshot_temp="$(/usr/bin/mktemp "${baseline_parent}/.robot-baseline.XXXXXX")"
remove_snapshot_temp() {
  /usr/bin/rm -f -- "$snapshot_temp"
  cleanup
}
trap remove_snapshot_temp EXIT

/usr/bin/python3 - "$temp_dir" >"$snapshot_temp" <<'PY'
import hashlib
import json
import re
import sys
from pathlib import Path

root = Path(sys.argv[1])

def endpoint(name: str) -> dict[str, object]:
    body = (root / f"{name}.body").read_bytes()
    text = body.decode("utf-8", errors="replace")
    match = re.search(r"<(?:title|h1)\b[^>]*>(.*?)</(?:title|h1)>", text, re.I | re.S)
    candidate = match.group(1) if match else text[:512]
    marker = re.sub(r"<[^>]+>|\s+", " ", candidate).strip()[:160]
    if not marker:
        raise SystemExit(f"{name} robot response has no stable marker")
    return {
        "status": int((root / f"{name}.status").read_text().strip()),
        "sha256": hashlib.sha256(body).hexdigest(),
        "marker": marker,
    }

json.dump({"public": endpoint("public"), "local": endpoint("local")}, sys.stdout, ensure_ascii=False, sort_keys=True)
sys.stdout.write("\n")
PY
/usr/bin/chown root:root "$snapshot_temp"
/usr/bin/chmod 0600 "$snapshot_temp"

if [[ "$action" == "capture" ]]; then
  [[ ! -e "$baseline_path" ]] || die "robot baseline already exists: ${baseline_path}"
  /usr/bin/mv -T -- "$snapshot_temp" "$baseline_path"
  trap cleanup EXIT
  cleanup
  trap - EXIT HUP INT TERM
  log "captured public and 127.0.0.1:8080 robot fingerprints"
  exit 0
fi

[[ -f "$baseline_path" ]] || die "robot baseline is missing: ${baseline_path}"
[[ "$(/usr/bin/stat -c '%U:%G:%a' "$baseline_path")" == "root:root:600" ]] || die "robot baseline ownership or mode is unsafe"
/usr/bin/python3 - "$baseline_path" "$snapshot_temp" <<'PY'
import json
import sys

with open(sys.argv[1], encoding="utf-8") as handle:
    before = json.load(handle)
with open(sys.argv[2], encoding="utf-8") as handle:
    after = json.load(handle)
for endpoint in ("public", "local"):
    for field in ("status", "marker", "sha256"):
        if before.get(endpoint, {}).get(field) != after.get(endpoint, {}).get(field):
            raise SystemExit(f"robot {endpoint} {field} changed across deployment")
PY

trap cleanup EXIT
/usr/bin/rm -f -- "$snapshot_temp"
cleanup
trap - EXIT HUP INT TERM
log "robot public marker/fingerprint and 127.0.0.1:8080 fingerprint are unchanged"

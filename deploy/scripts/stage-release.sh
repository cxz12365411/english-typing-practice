#!/usr/bin/env bash
set -euo pipefail

readonly SOURCE_ROOT="/srv/english-typing-practice-source"
readonly INCOMING_ROOT="/var/tmp/english-typing-practice/incoming"
readonly BUILD_ROOT="/var/tmp/english-typing-practice/build"
readonly BUILD_HOME="/var/cache/english-typing-practice-build"
readonly BUILD_USER="englishbuild"
readonly BUILD_GROUP="englishbuild"

log() {
  printf '[englishapp-stage] %s\n' "$*" >&2
}

die() {
  log "ERROR: $*"
  exit 1
}

[[ "${EUID}" -eq 0 ]] || die "run this script as root on the Ubuntu target so native modules match production"
[[ $# -eq 1 ]] || die "usage: stage-release.sh <release-id>"
readonly release_id="$1"
[[ "$release_id" =~ ^[0-9a-f]{7,64}$ ]] || die "release id must be a 7-64 character lowercase hexadecimal Git commit"
readonly incoming="${INCOMING_ROOT}/${release_id}"
readonly staging="${INCOMING_ROOT}/.staging-${release_id}-$$"
readonly build_dir="${BUILD_ROOT}/${release_id}-$$"

for command_path in /usr/bin/node /usr/bin/npm /usr/bin/git /usr/bin/tar; do
  [[ -x "$command_path" ]] || die "required command is missing: ${command_path}"
done
readonly RUNUSER="$(command -v runuser || true)"
[[ -n "$RUNUSER" && -x "$RUNUSER" ]] || die "runuser is required (normally /usr/sbin/runuser)"
[[ "$(/usr/bin/node -p 'process.versions.node.split(".")[0]')" == "22" ]] || die "Node.js 22 is required"
[[ -d "$SOURCE_ROOT/.git" && ! -L "$SOURCE_ROOT" ]] || die "source checkout is missing: ${SOURCE_ROOT}"
[[ -f "$SOURCE_ROOT/package-lock.json" && ! -L "$SOURCE_ROOT/package-lock.json" ]] || die "a committed root package-lock.json is required"
[[ -d "$INCOMING_ROOT" && ! -L "$INCOMING_ROOT" ]] || die "invalid incoming root; run provision-host.sh first"
[[ -d "$BUILD_ROOT" && ! -L "$BUILD_ROOT" ]] || die "invalid build root; run provision-host.sh first"
[[ -d "$BUILD_HOME" && ! -L "$BUILD_HOME" ]] || die "invalid build home; run provision-host.sh first"
[[ "$(/usr/bin/id -un "$BUILD_USER" 2>/dev/null)" == "$BUILD_USER" ]] || die "the unprivileged build account is missing"
[[ ! -e "$incoming" && ! -e "$staging" && ! -e "$build_dir" ]] || die "release workspace already exists; refusing to overwrite"

readonly actual_commit="$(/usr/bin/git -C "$SOURCE_ROOT" rev-parse HEAD)"
[[ "$actual_commit" == "$release_id" ]] || die "source HEAD ${actual_commit} does not match requested release ${release_id}"
[[ -z "$(/usr/bin/git -C "$SOURCE_ROOT" status --porcelain --untracked-files=normal)" ]] || die "source checkout is dirty; commit or remove changes before staging"

cleanup() {
  if [[ -d "$staging" && ! -L "$staging" ]]; then
    /usr/bin/find "$staging" -depth -mindepth 1 -delete
    /usr/bin/rmdir "$staging"
  fi
  if [[ -d "$build_dir" && ! -L "$build_dir" ]]; then
    /usr/bin/find "$build_dir" -xdev -depth -mindepth 1 -delete
    /usr/bin/rmdir "$build_dir"
  fi
}
trap cleanup EXIT

log "building ${release_id} as unprivileged account ${BUILD_USER}"
/usr/bin/install -d -m 0700 -o "$BUILD_USER" -g "$BUILD_GROUP" "$build_dir"
/usr/bin/git -C "$SOURCE_ROOT" archive --format=tar "$release_id" |
  "$RUNUSER" --user "$BUILD_USER" -- /usr/bin/tar -xf - -C "$build_dir"
"$RUNUSER" --user "$BUILD_USER" -- /bin/bash -c '
  set -euo pipefail
  cd "$1"
  /usr/bin/env HOME="$2" npm_config_cache="$2/.npm" /usr/bin/npm ci --no-audit --no-fund
  /usr/bin/env HOME="$2" npm_config_cache="$2/.npm" /usr/bin/npm run build
  /usr/bin/env HOME="$2" npm_config_cache="$2/.npm" /usr/bin/npm prune --omit=dev --no-audit --no-fund
' englishapp-build "$build_dir" "$BUILD_HOME"

for required_path in server/dist/index.js server/dist/scripts/migrate.js server/dist/scripts/bootstrap-admin.js web/dist/index.html web/dist/manifest.webmanifest web/dist/sw.js node_modules; do
  [[ -e "${build_dir}/${required_path}" ]] || die "build output is missing ${required_path}"
done

/usr/bin/install -d -m 0700 -o root -g root "$staging" "$staging/server" "$staging/web"
/usr/bin/cp -a -- "$build_dir/server/dist" "$staging/server/dist"
/usr/bin/cp -a -- "$build_dir/node_modules" "$staging/server/node_modules"
/usr/bin/install -m 0600 -o root -g root "$build_dir/server/package.json" "$staging/server/package.json"
/usr/bin/cp -a -- "$build_dir/web/dist" "$staging/web/dist"
/usr/bin/install -m 0600 -o root -g root "$build_dir/basic-english-850.md" "$staging/basic-english-850.md"
/usr/bin/install -m 0600 -o root -g root "$build_dir/daily-english-high-frequency-sentences.md" "$staging/daily-english-high-frequency-sentences.md"

for workspace_link in english-typing-practice-server english-typing-practice-web; do
  candidate="${staging}/server/node_modules/${workspace_link}"
  if [[ -L "$candidate" ]]; then
    /usr/bin/rm -- "$candidate"
  elif [[ -e "$candidate" ]]; then
    die "unexpected non-symlink workspace package in production node_modules: ${candidate}"
  fi
done

printf '{"commit":"%s","builtAt":"%s","node":"%s"}\n' \
  "$release_id" \
  "$(/usr/bin/date -u +%Y-%m-%dT%H:%M:%SZ)" \
  "$(/usr/bin/node --version)" >"${staging}/release.json"

/usr/bin/chown -R root:root "$staging"
/usr/bin/chmod -R go-rwx "$staging"
/usr/bin/mv -T -- "$staging" "$incoming"
cleanup
trap - EXIT
log "staged immutable release at ${incoming}"

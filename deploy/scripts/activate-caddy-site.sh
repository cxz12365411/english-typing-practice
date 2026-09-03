#!/usr/bin/env bash
set -euo pipefail

readonly CADDY_MAIN="/etc/caddy/Caddyfile"
readonly CADDY_SITE="/etc/caddy/english-typing-practice.caddy"
readonly CANDIDATE_SITE="/usr/local/share/english-typing-practice/caddy-site.caddy"
readonly REWRITER="/usr/local/libexec/english-typing-practice/rewrite-caddy.py"
readonly DEPLOYMENT_ROOT="/var/lib/english-typing-practice-deployments"
readonly MANAGED_IMPORT="import /etc/caddy/english-typing-practice.caddy"

log() {
  printf '[englishapp-caddy] %s\n' "$*" >&2
}

die() {
  log "ERROR: $*"
  exit 1
}

[[ "${EUID}" -eq 0 ]] || die "run this script as root"
[[ $# -eq 1 ]] || die "usage: activate-caddy-site.sh <release-id>"
readonly release_id="$1"
[[ "$release_id" =~ ^[0-9a-f]{7,64}$ ]] || die "release id must be a 7-64 character lowercase hexadecimal Git commit"
readonly state_dir="${DEPLOYMENT_ROOT}/${release_id}"
[[ -d "$state_dir" && ! -L "$state_dir" ]] || die "missing deployment state directory: ${state_dir}"

for required in "$CADDY_MAIN" "$CANDIDATE_SITE" "$REWRITER"; do
  [[ -f "$required" && ! -L "$required" ]] || die "required regular file is missing: ${required}"
done
for command_path in /usr/bin/caddy /usr/bin/python3 /usr/bin/mktemp /usr/bin/stat /usr/bin/systemctl /usr/bin/sha256sum /usr/bin/awk; do
  [[ -x "$command_path" ]] || die "required command is missing: ${command_path}"
done

readonly main_backup="${state_dir}/Caddyfile.before"
readonly site_backup="${state_dir}/caddy-site.before"
readonly site_absent="${state_dir}/caddy-site.was-absent"
readonly change_marker="${state_dir}/caddy-change-started"
readonly activated_marker="${state_dir}/caddy-activated"
readonly restored_marker="${state_dir}/caddy-restored"
readonly main_after_hash="${state_dir}/Caddyfile.after.sha256"
readonly site_after_hash="${state_dir}/caddy-site.after.sha256"
for state_path in "$main_backup" "$site_backup" "$site_absent" "$change_marker" "$activated_marker" "$restored_marker" "$main_after_hash" "$site_after_hash"; do
  [[ ! -e "$state_path" ]] || die "Caddy state already exists for release ${release_id}"
done

# Preserve the exact owner/mode in the root-only state directory.
/usr/bin/cp -a -- "$CADDY_MAIN" "$main_backup"
if [[ -e "$CADDY_SITE" ]]; then
  [[ -f "$CADDY_SITE" && ! -L "$CADDY_SITE" ]] || die "active Caddy site must be a regular, non-symlink file"
  /usr/bin/cp -a -- "$CADDY_SITE" "$site_backup"
else
  /usr/bin/install -m 0600 -o root -g root /dev/null "$site_absent"
fi

readonly main_temp="$(/usr/bin/mktemp /etc/caddy/.Caddyfile.englishapp.XXXXXX)"
readonly site_temp="$(/usr/bin/mktemp /etc/caddy/.english-typing-practice.caddy.XXXXXX)"
committed=0
change_started=0

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

restore_prior_config() {
  # Site first keeps an existing import resolvable. For an absent site, remove the import first.
  if [[ -f "$site_backup" ]]; then
    atomic_copy_with_reference "$site_backup" "$CADDY_SITE" "$site_backup" || return 1
    atomic_copy_with_reference "$main_backup" "$CADDY_MAIN" "$main_backup" || return 1
  else
    atomic_copy_with_reference "$main_backup" "$CADDY_MAIN" "$main_backup" || return 1
    /usr/bin/rm -f -- "$CADDY_SITE" || return 1
  fi
  if /usr/bin/caddy validate --config "$CADDY_MAIN" --adapter caddyfile >/dev/null 2>&1 &&
     /usr/bin/systemctl reload caddy.service; then
    /usr/bin/install -m 0600 -o root -g root /dev/null "$restored_marker"
    return 0
  fi
  log "CRITICAL: saved Caddy files were reinstalled but validate/reload needs operator attention"
  return 1
}

cleanup() {
  /usr/bin/rm -f -- "$main_temp" "$site_temp"
}

on_exit() {
  local status=$?
  trap - EXIT HUP INT TERM
  cleanup || true
  if [[ "$status" -ne 0 && "$change_started" -eq 1 && "$committed" -eq 0 ]]; then
    log "activation interrupted; atomically restoring the saved Caddy files"
    restore_prior_config || true
  fi
  exit "$status"
}
trap on_exit EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

/usr/bin/python3 "$REWRITER" "$CADDY_MAIN" >"$main_temp"
if ! /usr/bin/grep -Fqx "$MANAGED_IMPORT" "$main_temp"; then
  {
    printf '\n# BEGIN managed English Typing Practice import\n'
    printf '%s\n' "$MANAGED_IMPORT"
    printf '# END managed English Typing Practice import\n'
  } >>"$main_temp"
fi
/usr/bin/cp -- "$CANDIDATE_SITE" "$site_temp"

/usr/bin/chown --reference="$CADDY_MAIN" "$main_temp"
/usr/bin/chmod --reference="$CADDY_MAIN" "$main_temp"
if [[ -f "$site_backup" ]]; then
  /usr/bin/chown --reference="$site_backup" "$site_temp"
  /usr/bin/chmod --reference="$site_backup" "$site_temp"
else
  /usr/bin/chown root:root "$site_temp"
  /usr/bin/chmod 0644 "$site_temp"
fi

/usr/bin/install -m 0600 -o root -g root /dev/null "$change_marker"
change_started=1
# Candidates live beside their targets, so each rename is atomic and never exposes a partial file.
/usr/bin/mv -Tf -- "$site_temp" "$CADDY_SITE"
/usr/bin/mv -Tf -- "$main_temp" "$CADDY_MAIN"

write_hash() {
  local source_path="$1"
  local destination="$2"
  local hash_temp
  hash_temp="$(/usr/bin/mktemp "${state_dir}/.$(/usr/bin/basename -- "$destination").XXXXXX")"
  /usr/bin/sha256sum -- "$source_path" | /usr/bin/awk '{print $1}' >"$hash_temp"
  /usr/bin/chown root:root "$hash_temp"
  /usr/bin/chmod 0600 "$hash_temp"
  /usr/bin/mv -Tf -- "$hash_temp" "$destination"
}
write_hash "$CADDY_MAIN" "$main_after_hash"
write_hash "$CADDY_SITE" "$site_after_hash"

/usr/bin/caddy validate --config "$CADDY_MAIN" --adapter caddyfile || die "candidate Caddy configuration is invalid"
/usr/bin/systemctl reload caddy.service || die "Caddy reload failed"
/usr/bin/install -m 0600 -o root -g root /dev/null "$activated_marker"
committed=1
trap - EXIT HUP INT TERM
cleanup
log "English site activated; exact prior Caddy metadata and content are in ${state_dir}"

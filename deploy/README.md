# Production deployment

This directory deploys the multi-user application without reusing or overwriting its
SQLite data. It is intentionally tied to the following production layout:

- source checkout: `/srv/english-typing-practice-source`
- immutable releases: `/opt/english-typing-practice/releases/<git-commit>`
- active symlink: `/opt/english-typing-practice/current`
- database: `/var/lib/english-typing-practice/app.db`
- root-only deployment state: `/var/lib/english-typing-practice-deployments`
- protected lock files: `/var/lib/english-typing-practice-locks`
- environment: `/etc/english-typing-practice/env`
- backups: `/var/backups/english-typing-practice`
- API listener: `127.0.0.1:8091`
- public origin: `https://english-47-120-37-63.sslip.io`

English-site access logs are written to the existing Caddy systemd journal rather
than a separate file, so configuration validation and runtime use the same permissions.

The filesystem boundary is deliberate: `/opt/english-typing-practice` and each
release root are traversable `root:root 0755`; `server/` is `root:englishapp 0750`
with `0640` files; `web/` is `root:caddy 0750` with `0640` files. The two service
accounts are rejected if they share each other's group. Caddy therefore cannot read
server code, the database, deployment state, locks, or `/etc/english-typing-practice/env`,
and the API account cannot read Web assets. Persistent data and configuration remain
outside the public root.

The old static deployment under `/var/www/english-typing-practice/current` is left
untouched. The first activation stores the complete prior Caddyfile before replacing
only a dedicated English-host block. The robot host is never generated or edited by
these assets.

## First deployment

The host must be Ubuntu with systemd, Caddy, SQLite CLI, Python 3, curl, OpenSSL,
Git, and Node.js **22** installed at the standard `/usr/bin` paths. Build native Node
modules on the Ubuntu target, not on Windows.

1. Clone the intended branch and verify the commit:

   ```bash
   sudo git clone --branch codex/multi-user-auth \
     https://github.com/cxz12365411/english-typing-practice.git \
     /srv/english-typing-practice-source
   cd /srv/english-typing-practice-source
   git status --short
   git rev-parse HEAD
   ```

2. Provision fixed directories and systemd assets. This does **not** touch the live
   Caddyfile or old static site:

   ```bash
   sudo bash deploy/scripts/provision-host.sh
   sudo systemctl status englishapp-backup-daily.timer englishapp-backup-weekly.timer
   ```

3. Review `/etc/english-typing-practice/env`. The provisioner preserves existing
   values except for an exact legacy `TRUST_PROXY=true`, which it backs up and
   atomically narrows to `TRUST_PROXY=loopback`. It also generates a persistent random
   `GUEST_TOKEN_SECRET` and an independent `EMAIL_CODE_SECRET` when either is absent or
   still set to its template placeholder. Missing email keys are appended with
   fail-closed defaults in one atomic update. Every changed environment is first copied
   to the root-only `host-config` backup directory. Re-running the provisioner preserves
   configured SMTP values and produces no duplicate keys. The deployer refuses an
   unexpected origin, bind address, port, database path, proxy policy, owner,
   permissions, placeholder secret, production `EMAIL_DELIVERY=test`, incomplete SMTP
   settings, any SMTP port other than implicit-TLS port 465, or an `EMAIL_FROM` that is
   not the authenticated `SMTP_USERNAME`. `TRUST_PROXY=loopback` trusts only the local
   Caddy hop.

4. Stage and deploy the exact commit:

   ```bash
   commit=$(git rev-parse HEAD)
   sudo /usr/local/libexec/english-typing-practice/stage-release.sh "$commit"
   sudo /usr/local/libexec/english-typing-practice/deploy-release.sh "$commit"
   ```

Provisioning creates a locked, non-login `englishbuild` account. The stage step exports
the exact clean Git commit into a private temporary directory, then runs `npm ci`, both
builds, and `npm prune` as that unprivileged account. Root only validates and installs
the resulting immutable files; lifecycle scripts from dependencies never run as root.

Before stopping the old API, deployment holds the deployment lock, writes recovery
state, captures public and `127.0.0.1:8080` robot-page markers/SHA-256 fingerprints,
and arms restart-only recovery. It then stops all API writers and takes the exact
pre-migration snapshot. A failure before the snapshot only restarts the unchanged old
service; after the snapshot, the EXIT/signal trap can restore the database, symlink,
Caddy files, and prior service state without losing writes made just before shutdown.
Caddy candidates are created in `/etc/caddy` and atomically renamed while retaining
each replaced file's owner and mode. Acceptance must confirm the robot fingerprints
are unchanged.

If no active administrator exists, deployment creates `admin` with a random 20-character
temporary password. Before displaying it, acceptance automatically creates a guest
CSRF session, logs in with the temporary credential, asserts `role=admin` and
`mustChangePassword=true`, and logs out. Only then is the password printed once at the
end; its runtime file is securely deleted. Until output succeeds, a root-only recovery
copy remains in that release's deployment-state directory, so a broken output pipe or
interruption cannot strand the initial account. Existing administrators are never reset.

## Email-code rollout: compatibility release, feature release, then activation

Email uses two code releases followed by two configuration stages. Do not enable
public registration during either code release. The existing administrator must retain
working username/password access until its own email address has been verified.

The Git history must contain these consecutive commits:

- **Compatibility Release A**: only the final migration 3 in `server/src/database.ts`
  and its migration test. It creates nullable email columns and new tables, while the
  old username/password application keeps working.
- **Feature Release B**: the complete server, web, deployment and documentation changes.
  It recognizes the same frozen migration 3 and initially runs with email disabled.

Install the new deployment helpers from Release B before staging Release A. This step
is required because the currently installed host helpers do not know the email settings
or SMTP preflight. It is idempotent and does not edit the live Caddy configuration:

```bash
sudo git -C /srv/english-typing-practice-source fetch origin
sudo git -C /srv/english-typing-practice-source checkout <release-b-commit>
cd /srv/english-typing-practice-source
sudo bash deploy/scripts/provision-host.sh
```

Then keep all email settings at their fail-closed defaults, check out and deploy Release
A, followed by Release B:

```bash
sudo git -C /srv/english-typing-practice-source checkout <release-a-commit>
sudo /usr/local/libexec/english-typing-practice/stage-release.sh <release-a-commit>
sudo /usr/local/libexec/english-typing-practice/deploy-release.sh <release-a-commit>

sudo git -C /srv/english-typing-practice-source checkout <release-b-commit>
sudo /usr/local/libexec/english-typing-practice/stage-release.sh <release-b-commit>
sudo /usr/local/libexec/english-typing-practice/deploy-release.sh <release-b-commit>
```

Release B can roll back to A with `--keep-database`. Rolling A back to the prior schema
2 release must use `--restore-database`; the schema 2 application intentionally refuses
to start against schema 3.

```bash
sudo /usr/local/libexec/english-typing-practice/rollback-release.sh \
  <release-b-commit> --keep-database
sudo /usr/local/libexec/english-typing-practice/rollback-release.sh \
  <release-a-commit> --restore-database
```

The relevant protected settings are:

| Setting | Production rule |
| --- | --- |
| `EMAIL_DELIVERY` | `disabled` (safe default) or `smtp`; never `test` |
| `EMAIL_CODE_SECRET` | independently generated by provisioning; do not edit or reuse the guest secret |
| `EMAIL_SELF_REGISTRATION` | keep `false` throughout both code releases and SMTP verification |
| `EMAIL_DAILY_SEND_LIMIT` | integer `1..10000`; default `180` |
| `EMAIL_REGISTRATION_DAILY_SEND_LIMIT` | registration-only subset of the daily allowance; default `20`, minimum `1`, never above the total limit |
| `EMAIL_REGISTRATION_IP_DAILY_LIMIT` | registrations allowed per source IP per China day; default `10`, never above the registration subset |
| `SMTP_HOST` | hostname shown by the mail provider |
| `SMTP_PORT` | exactly `465` (implicit TLS) |
| `SMTP_USERNAME` | verified sending email address |
| `SMTP_PASSWORD` | SMTP credential, stored only in the protected environment |
| `EMAIL_FROM` | exactly the same address as `SMTP_USERNAME` |
| `EMAIL_FROM_NAME` | optional visible sender name |

Never type the SMTP password in a command, chat, deployment log, or Git file. Use
`sudoedit /etc/english-typing-practice/env`; keep every entry as one unquoted literal
`KEY=value` line, choose an SMTP password without quote/backslash characters or edge
whitespace, and preserve `root:englishapp` ownership with mode `0640`.

### Enable SMTP for existing accounts

1. Activate a transactional/verification-email sender with the mail provider and
   finish its sender-domain verification. Take a root-only copy of the current env:

   ```bash
   stamp=$(date -u +%Y%m%dT%H%M%SZ)
   sudo install -m 0600 -o root -g root /etc/english-typing-practice/env \
     "/var/backups/english-typing-practice/host-config/env.before-email-rollout.${stamp}"
   ```

2. Run `sudoedit /etc/english-typing-practice/env`, set `EMAIL_DELIVERY=smtp`, fill the
   SMTP/sender values, and leave `EMAIL_SELF_REGISTRATION=false`. Do not change either
   generated secret. Keep both registration limits at or below the registration-only
   daily subset, and that subset below the total daily limit, so email login, password
   reset, and account binding retain delivery capacity. Validate
   syntax and policy without attempting a connection:

   ```bash
   sudo /usr/local/libexec/english-typing-practice/check-email-config.sh --config-only
   ```

3. With Feature Release B current, verify TLS and SMTP authentication without sending
   a message, then restart the API and run acceptance:

   ```bash
   sudo /usr/local/libexec/english-typing-practice/check-email-config.sh --smtp
   sudo systemctl restart englishapp.service
   sudo /usr/local/libexec/english-typing-practice/acceptance-test.sh
   ```

4. Sign in as the existing `admin` with username/password, open the account area, and
   bind the administrator email by entering its code. Then sign out and verify email-code
   login. Test email-code password reset on a disposable ordinary account before using
   it on the only administrator. Keep registration off until these checks pass.

The SMTP preflight loads `/etc/english-typing-practice/env` only after dropping to the
`englishapp` account. The password stays in the child environment, is never a command
argument, and is never included in success or failure logs. The check calls SMTP
`verify`; it does not send an email.

### Open self-registration

After an active administrator has a verified email, make a second root-only env backup,
change only `EMAIL_SELF_REGISTRATION=true` using `sudoedit`, and run:

```bash
sudo /usr/local/libexec/english-typing-practice/check-email-config.sh --config-only
sudo /usr/local/libexec/english-typing-practice/check-email-config.sh
sudo systemctl restart englishapp.service
sudo /usr/local/libexec/english-typing-practice/acceptance-test.sh
```

The validator refuses this configuration stage unless the database already contains at least one active
administrator with a verified email. After restart, an anonymous
`GET /api/auth/session` must report both `emailAuthEnabled` and
`selfRegistrationEnabled` as `true`; the login page will then expose registration.

To close registration without disabling email login/reset, atomically change only
`EMAIL_SELF_REGISTRATION` back to `false`, validate, restart the API, and repeat
acceptance. This does not modify Caddy or the robot service.

### Environment rollback

Code/database rollback cannot infer whether an SMTP config change should also be
reverted, so environment backups are intentionally separate. If either stage fails,
select the exact root-only env backup you created, install it through a temporary file,
and atomically replace the protected environment:

```bash
sudo install -m 0640 -o root -g englishapp \
  "/var/backups/english-typing-practice/host-config/<exact-env-backup>" \
  /etc/english-typing-practice/.env.rollback
sudo mv -Tf /etc/english-typing-practice/.env.rollback /etc/english-typing-practice/env
sudo /usr/local/libexec/english-typing-practice/check-email-config.sh --config-only
sudo systemctl restart englishapp.service
sudo /usr/local/libexec/english-typing-practice/acceptance-test.sh
```

Use an exact backup filename after inspecting the directory; never restore by wildcard.
Restoring an env does not alter the database, and restoring a database does not alter the
env. The robot host, its Caddy block, and `robot-control.service` are outside this email
configuration and remain unchanged in both stages.

## Verification and routine updates

Run anonymous production checks at any time:

```bash
sudo /usr/local/libexec/english-typing-practice/acceptance-test.sh
```

For a disposable test account, run the deeper login/content/logout check without
putting the password in a command-line argument:

```bash
sudo --preserve-env=ETP_TEST_USERNAME,ETP_TEST_PASSWORD \
  /usr/local/libexec/english-typing-practice/acceptance-test.sh
```

The deeper check asserts the secure session cookie, 18 categories, 1,018 items, CSRF
logout, and session revocation. Browser Playwright tests remain the acceptance source
for speech synthesis, input interaction, `localStorage` migration, and mobile layout.

For an update, fetch and fast-forward the fixed checkout, then repeat `stage-release.sh`
and `deploy-release.sh` with the new full commit ID. A release ID or state directory is
never overwritten. A successfully consumed `incoming/<commit>` is deleted. Cleanup
retains at least the five newest terminal releases and states, plus the active release,
its previous target, every incomplete state's references, and every database snapshot
referenced by retained state. Backup rotation also refuses to delete referenced
pre-migration/rollback-entry snapshots. Incoming deletion and retention pruning run
after the deployment commit and credential output; cleanup failures are warnings and
never turn an accepted live site into a failed deployment with undisclosed credentials.

## Backup, restore, and rollback

Daily backups run around 03:15 Asia/Shanghai and retain seven files. Weekly backups
run Sunday around 04:15 and retain four files. Both use SQLite's online backup API and
verify the resulting database. Inspect them with:

```bash
systemctl list-timers 'englishapp-backup-*'
sudo find /var/backups/english-typing-practice -maxdepth 2 -type f -name '*.sqlite3' -ls
```

Restore accepts only a managed-name backup under the fixed backup root. It first holds
both deployment and maintenance locks, validates the source with SQLite read-only mode,
creates recovery state, and records the old service status. After stopping the API it
re-resolves, re-identifies, and re-validates the source, then atomically installs a
verified copy. Its EXIT/signal trap reinstates the old database/WAL files and exact
prior service state if any step or health check fails. Displaced files are quarantined,
not deleted:

```bash
sudo /usr/local/libexec/english-typing-practice/restore-sqlite.sh \
  /var/backups/english-typing-practice/daily/<exact-file>.sqlite3
```

To roll back the current release, name that release and make the database choice
explicit. `--keep-database` is appropriate only when the old code supports the current
schema. `--restore-database` returns to the pre-migration snapshot and therefore
discards post-deployment database changes from the active database (they remain in
restore quarantine):

```bash
current=$(basename "$(readlink -f /opt/english-typing-practice/current)")
sudo /usr/local/libexec/english-typing-practice/rollback-release.sh \
  "$current" --restore-database
```

Rollback first verifies that the active Caddy main/site files still match the hashes
recorded immediately after this release was activated. If an operator or the robot site
changed Caddy later, rollback refuses before stopping or changing anything. Otherwise
it records the entry symlink, service state, Caddy files, and a post-stop database
snapshot. Any later error or signal restores that complete entry state atomically;
the parent arms Caddy recovery before invoking the child restore, so signals before,
during, or immediately after that call are covered. The final `rollback-complete`
marker is atomically published only after the in-memory transaction is committed and
its recovery trap is disarmed. Successful and failed rollback attempts retain
root-only forensic state.

On the first-release rollback, the saved Caddyfile points back to the untouched
`/var/www/english-typing-practice/current` static site. Caddy is validated before every
reload. If a legacy English hostname occurs in a shared multi-host Caddy block, the
activation refuses to edit it and requires a deliberate manual split.

## GitHub Pages retirement (manual, after production acceptance)

Do not disable the fallback before the new site and administrator login pass testing.
No deployment script calls the GitHub API. To disable it manually:

1. Open `cxz12365411/english-typing-practice` on GitHub.
2. Go to **Settings → Pages**.
3. Under **Build and deployment**, set **Source** to **Deploy from a branch** if needed,
   then select **None** for the publishing branch and save/disable the site.
4. Confirm `https://cxz12365411.github.io/english-typing-practice/` no longer serves the
   fallback, while `https://english-47-120-37-63.sslip.io/` still passes acceptance.

If branch-based Pages cannot be set to None in the current GitHub UI, remove only the
Pages publishing source in repository Settings; do not delete `main`, the release
branch, or the repository.

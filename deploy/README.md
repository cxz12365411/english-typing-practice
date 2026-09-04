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
   `GUEST_TOKEN_SECRET` when absent or still set to the template placeholder. The
   deployer refuses an unexpected origin, bind address, port, database path, proxy
   policy, owner, permissions, or placeholder secret. `TRUST_PROXY=loopback` trusts
   only the local Caddy hop.

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

# English Typing Practice

A multi-user English typing practice application with synchronized progress, an
administrator console, content publishing, and an installable PWA shell.

## Applications

- `/login` — account sign-in and first-login password change
- `/practice` — word/sentence practice, speech, personal statistics, and mistakes
- `/admin` — users, content, CSV import, publishing, statistics, and audit log
- `/api/healthz` — API readiness check

Public registration is intentionally disabled. Administrators create accounts and
receive a temporary password that is shown once. Every temporary password must be
changed at first sign-in.

## Local development

Requirements: Node.js 22 or newer and npm 10 or newer.

```bash
npm install
npm run build
```

Set the server environment, migrate the database, and create the first administrator:

```bash
export DATABASE_PATH=/tmp/english-typing-practice.db
export APP_ORIGIN=http://localhost:5173
export CONTENT_SOURCE_DIR="$PWD"
export GUEST_TOKEN_SECRET='replace-with-at-least-32-random-bytes'
export TRUST_PROXY=false
printf '%s\n' 'temporary-password-at-least-12-chars' >/tmp/etp-admin-password
npm run db:migrate --workspace server
npm run admin:bootstrap --workspace server -- --username admin --password-file /tmp/etp-admin-password
rm /tmp/etp-admin-password
npm run dev
```

The Vite development server proxies `/api` to `127.0.0.1:8091`.

## Verification

```bash
npm run build
npm test
npm run test:e2e
python -m pytest deploy/tests -q
```

The browser suite uses an isolated temporary SQLite database and local Chrome. It
covers onboarding, account isolation, synchronized attempts, legacy mistake import,
navigation races, unsynchronized-answer protection, PWA assets, and mobile layout.

## Production

Production deployment assets and the rollback/restore runbook are documented in
[`deploy/README.md`](deploy/README.md). The supported layout uses:

- Caddy for HTTPS and static files
- Fastify on `127.0.0.1:8091`
- SQLite outside the release directory
- systemd sandboxing and scheduled consistent backups
- immutable release directories with an atomic `current` symlink

The original Markdown files are seed inputs. They remain in this public repository,
but are not served by the authenticated production application.

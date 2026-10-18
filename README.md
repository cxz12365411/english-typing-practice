# English Typing Practice

A multi-user English typing practice application with synchronized progress, an
administrator console, content publishing, and an installable PWA shell.

## Applications

- `/login` — username/password or email-code sign-in, email registration, and
  email-code password reset when email delivery is enabled
- `/practice` — word/sentence practice, speech, personal statistics, and mistakes
- `/admin` — users, content, Markdown/CSV import, publishing, statistics, and audit log
- `/api/healthz` — API readiness check

Email delivery and public registration are fail-closed by default. Administrators can
still create accounts and receive a temporary password that is shown once. Production
enables SMTP first with registration still disabled, binds and verifies the existing
administrator's email, tests email login/reset, and only then enables self-registration.

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
export EMAIL_CODE_SECRET='use-a-different-at-least-32-byte-random-value'
export EMAIL_DELIVERY=disabled
export EMAIL_SELF_REGISTRATION=false
export EMAIL_DAILY_SEND_LIMIT=180
export EMAIL_REGISTRATION_DAILY_SEND_LIMIT=20
export EMAIL_REGISTRATION_IP_DAILY_LIMIT=10
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
python -m unittest discover -s deploy/tests -v
```

The browser suite uses an isolated temporary SQLite database and local Chrome. It
covers onboarding, account isolation, synchronized attempts, legacy mistake import,
navigation races, unsynchronized-answer protection, PWA assets, and mobile layout.

### Speech settings

The account practice page and no-login pages (`index.html` and
`typing-practice.html`) include **朗读设置**:
choose an English voice, preview it, and adjust speed from 0.75× to 1.25×. Automatic
selection prefers available Samantha voices (Premium, Enhanced, then standard)
and excludes known novelty voices. Voice availability depends on the browser;
the settings are saved locally and the default speed is 1.0× for all text lengths.
If a saved voice disappears, a recommended voice is used until it returns.

Run `npm run test:static` for the standalone regression suite. It uses headless
Chrome with a simulated speech service to exercise loading, preferences and
cancellation; actual sound quality still needs listening in the target browser.
Keep both standalone HTML files identical. GitHub Pages publishes from the
`codex/static-pages` branch; preserve its account-site navigation banner when
applying standalone updates from `main`.

### English–Chinese alignment arrows

The account practice page and both standalone pages share `alignment.js`,
`alignment.css`, and `sentence-alignments.json`. The account build bundles the
renderer and styles and publishes the data with a content-hashed asset URL.
**对应箭头** is enabled by default and saved in the
current browser. Hover, click, or Tab to an English word to highlight its semantic
group and explanation; Escape clears the selection. On narrow screens, scroll
inside the two-line diagram. Hiding English also removes its arrows and hints.

All 850 words link to their existing complete definitions. The 270 sentences have
reviewed semantic groups: contractions, hyphenated words, numbers, and `____` are
tokens; punctuation and spaces remain unchanged. Articles, auxiliaries, idioms,
and omitted words belong to their full expression, with explanatory notes where
needed. These links describe the supplied translation, not a word-by-word
dictionary translation.

Each alignment entry contains exact `english` and `meaning` strings, `zhParts`
whose concatenation must equal `meaning`, and `groups` with zero-based `en` token
indices, `zh` part indices, and an optional `note`. Every English token belongs to
exactly one group. Discontiguous Chinese targets receive separate arrows. Lookup
uses `JSON.stringify([english, meaning])`; practice answers and mistake identities
are unchanged. Missing, invalid, or mismatched entries fall back to plain text.
Loading this optional data does not reset an answer in progress.

Account-site imports retain their own question IDs, revisions, translations and
learning records. Single words use their complete definition; imported sentences
without an exact reviewed alignment remain plain text. This frontend update does
not replace the server's question bank. Account navigation cancels pending speech
and alignment loading before a new page takes ownership of the controls.

When editing the corpus, update the matching alignment entry and review its
meaning. Run `npm run test:static` to check exact coverage, indices, Chinese
concatenation, DOM geometry, mobile overflow, accessibility interactions, failure
fallbacks, scoring, mistakes, and speech regressions. Publish all three alignment
assets alongside both HTML entries on `codex/static-pages`.

## Markdown imports

Administrators can open **批量导入 → Markdown** (or **题库管理 → 从 MD 导入**),
upload/drop a UTF-8 `.md` / `.markdown` file, or paste its text. After automatic
preview and any category adjustments, **导入并发布，开始练习** publishes the new
content and opens only the file's items. Existing translations, pronunciation,
item identities and learning records are never overwritten by Markdown imports.

The download template uses `英文 | 中文释义 | 中文谐音` columns. Existing word-list,
sentence-table and street-photography paragraph documents are also supported.
English/meaning are required; pronunciation is optional. No AI or external API is
used. Limits are 1 MiB UTF-8 text and 5000 records per import.

See [the import guide](docs/markdown-import.md). GitHub Pages remains a separate
standalone site; account-site imports are only published there through an explicit,
reviewed content sync, not automatically.

## Production

Production deployment assets and the rollback/restore runbook are documented in
[`deploy/README.md`](deploy/README.md). The supported layout uses:

- Caddy for HTTPS and static files
- Fastify on `127.0.0.1:8091`
- SQLite outside the release directory
- systemd sandboxing and scheduled consistent backups
- immutable release directories with an atomic `current` symlink
- protected SMTP settings, email-code login/reset, and a fail-closed two-stage
  self-registration rollout

The original Markdown files are seed inputs. They remain in this public repository,
but are not served by the authenticated production application.

The bundled corpus contains 850 words and 270 sentences across 26 categories,
including 70 street-photography phrases and 32 bar-social phrases. The September 2026
content update is applied once to existing databases, preserving existing item IDs,
accounts, progress, and subsequent administrator edits. Merely editing a Markdown
file does not overwrite an already-seeded database; additions need an explicit,
transactional content update. Street-photography tables use a third `Stable ID`
column so adding phrases within a category never changes existing item identities.
See [the initial sync notes](docs/content-sync-2026-09-15.md),
[the 24-phrase expansion](docs/content-sync-2026-09-16.md), and
[the October 32-phrase sync](docs/content-sync-2026-10-10.md).

The October additions were already published to the account site through the
administrator's Markdown import. This repository update also publishes them to
the no-login GitHub Pages site and includes them in new-installation seed data.
It does not add a third automatic content patch or re-import existing databases.
The reusable three-column [32-phrase Markdown](docs/street-photography-extra-32.md)
contains only public practice content, not accounts or learning records.

The [32 bar-social phrases](docs/bar-social-extra-32.md) add four scenarios:
friendly introductions, drinks and toasts, conversation and invitations, and
exchanging contacts or saying goodbye. Each includes a Chinese meaning and an
approximate Chinese pronunciation hint, using the existing speech feature.
See [the bar-social sync notes](docs/content-sync-2026-10-13.md). Existing accounts
receive the additions through the ordinary administrator Markdown import, not a
new automatic content patch or database migration.

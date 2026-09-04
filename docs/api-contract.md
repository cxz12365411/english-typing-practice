# API contract

All endpoints are same-origin under `/api`. JSON uses camelCase. Mutating authenticated
requests must include `X-CSRF-Token`, obtained from login or `GET /api/auth/session`.
Errors use `{ "error": { "code": string, "message": string, "details"?: unknown } }`.

## Authentication

- `POST /api/auth/login` — `{ username, password }` → `{ user, csrfToken }`
- `GET /api/auth/session` → `{ user, csrfToken }`; anonymous callers receive
  `{ user: null, csrfToken }` and a short-lived signed, stateless guest cookie so login can be
  CSRF-protected. The response also includes
  `{ capabilities: { emailAuthEnabled, selfRegistrationEnabled } }`. Login and every
  other write must send that cookie, exact `Origin`, and `X-CSRF-Token`.
- `POST /api/auth/logout` → `{ ok: true }`
- `POST /api/auth/change-password` — `{ currentPassword, newPassword }` → `{ user, csrfToken }`
- `POST /api/auth/email/request-code` —
  `{ email, purpose: "register"|"login"|"reset_password"|"bind_email" }` →
  `202 { ok: true, challengeId, expiresInSeconds, retryAfterSeconds }`. `bind_email` requires an
  authenticated user. Requests for unknown/ineligible login or reset addresses return
  the same accepted shape and do not disclose account existence.
- `POST /api/auth/email/register` —
  `{ email, challengeId, code, username, displayName, password }` → `{ user, csrfToken }`; available
  only when both email delivery and self-registration are enabled. New accounts have
  role `user`.
- `POST /api/auth/email/login` — `{ email, challengeId, code }` → `{ user, csrfToken }`
- `POST /api/auth/email/reset-password` —
  `{ email, challengeId, code, newPassword }` → `{ user, csrfToken }`; resets the password, clears
  the forced-change flag, revokes existing sessions, and returns a new session.
- `POST /api/auth/email/bind` — `{ email, challengeId, code, currentPassword }` → `{ user, csrfToken }`;
  requires a signed-in account without an email plus recent password reauthentication,
  binds a unique verified address, revokes the old session, and returns a new session.

`user` contains `id`, `username`, `displayName`, `role`, `status`,
`mustChangePassword`, `createdAt`, optional `lastLoginAt`, and optional verified `email`.

Email codes are six digits, single-use, purpose-bound, account/auth-version-bound where
applicable, bound to the requesting browser session and opaque `challengeId`, and expire
after ten minutes. A new request never invalidates another browser's challenge. Code requests have a one-minute resend
cooldown plus persistent email/IP/pair limits; verification attempts and daily sends are
also limited. Registration has a smaller daily sub-limit so login, password reset, and
binding retain capacity. Only eligible deliveries consume the configured allowances.
SMTP-disabled requests return `503`; disabled self-registration returns `403`; invalid
or expired codes return a generic `401`; throttling or daily exhaustion returns `429`.

## Practice

- `GET /api/content` → `{ version, categories, items }`
- `POST /api/practice/sessions` — `{ categoryId?, mode: "sequential"|"random"|"mistakes" }`
  → `{ session }`; creating one closes the user's previous active practice session.
- `POST /api/practice/sessions/:id/attempts` —
  `{ clientAttemptId, itemId, itemRevision, answer, durationMs, occurredAt? }`
  → `{ attempt, summary }`. The server judges the answer and never persists its raw text.
- `POST /api/practice/sessions/:id/finish` — `{ durationMs? }` → `{ session }`
- `GET /api/me/summary`
- `GET /api/me/mistakes` → `{ items }`
- `POST /api/me/mistakes/import` — `{ answers }` → `{ imported, unmatched, alreadyImported }`

## Administration

- `GET|POST /api/admin/users`
- `PATCH /api/admin/users/:id`
- `POST /api/admin/users/:id/reset-password` — issues a one-time password, clears any
  bound email as an emergency account-recovery action, and revokes existing sessions
- `POST /api/admin/users/:id/revoke-sessions`
- `GET /api/admin/stats`
- `GET|POST /api/admin/categories`
- `PATCH /api/admin/categories/:id`
- `GET|POST /api/admin/items`
- `PATCH /api/admin/items/:id`
- `POST /api/admin/items/:id/publish`
- `POST /api/admin/items/:id/archive`
- `POST /api/admin/imports/preview` — `{ csv, categoryId? }`
  → `{ previewId, rows, errors, expiresAt }`
- `POST /api/admin/imports/commit` — `{ previewId }`
- `GET /api/admin/audit`

Only authenticated administrators may access `/api/admin/*`. A regular user receives
`403`; an anonymous request receives `401`.

## Operations

- `GET /api/healthz` returns a minimal readiness response and no sensitive data.
- `401` unauthenticated; `403` unauthorized; `409` state conflict; `422` invalid input;
  `429` login/email throttled; `503` email delivery unavailable.

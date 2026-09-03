# API contract

All endpoints are same-origin under `/api`. JSON uses camelCase. Mutating authenticated
requests must include `X-CSRF-Token`, obtained from login or `GET /api/auth/session`.
Errors use `{ "error": { "code": string, "message": string, "details"?: unknown } }`.

## Authentication

- `POST /api/auth/login` — `{ username, password }` → `{ user, csrfToken }`
- `GET /api/auth/session` → `{ user, csrfToken }`; anonymous callers receive
  `{ user: null, csrfToken }` and a short-lived signed, stateless guest cookie so login can be
  CSRF-protected. Login must send that cookie, `Origin`, and `X-CSRF-Token`.
- `POST /api/auth/logout` → `{ ok: true }`
- `POST /api/auth/change-password` — `{ currentPassword, newPassword }` → `{ user, csrfToken }`

`user` contains `id`, `username`, `displayName`, `role`, `status`,
`mustChangePassword`, `createdAt`, and optional `lastLoginAt`.

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
- `POST /api/admin/users/:id/reset-password`
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
  `429` login throttled.

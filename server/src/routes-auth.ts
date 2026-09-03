import type { FastifyInstance, FastifyRequest } from "fastify";
import type { SqliteDatabase } from "./database.js";
import {
  audit,
  clearLoginGuards,
  clearSessionCookie,
  createGuestSession,
  createSession,
  requireUser,
  revalidateAuthenticatedActor,
  revokeSession,
  revokeUserSessions,
  toUserDto,
  type UserRow
} from "./auth.js";
import { ApiError, badRequest } from "./errors.js";
import { hashPassword, normalizeUsername, tokenHash, validatePassword, validateUsername, verifyPassword } from "./security.js";
import { objectBody, stringField } from "./validation.js";

const LIMIT_WINDOW_MS = 15 * 60_000;
const BLOCK_MS = 15 * 60_000;
const IP_ATTEMPT_LIMIT = 60;
const IP_ACCOUNT_ATTEMPT_LIMIT = 10;

type GuardScope = "ip" | "ip_account" | "account_risk";

interface GuardRow {
  window_started_at: number;
  reservation_count: number;
  failure_count: number;
  blocked_until: number | null;
}

function pairGuardKey(account: string, ip: string): string {
  return tokenHash(`${account}\n${ip}`);
}

function guardState(db: SqliteDatabase, scope: GuardScope, key: string, now: number): GuardRow {
  const row = db.prepare(`
    SELECT window_started_at, reservation_count, failure_count, blocked_until
    FROM login_guards WHERE scope = ? AND guard_key = ?
  `).get(scope, key) as GuardRow | undefined;
  if (!row || row.window_started_at <= now - LIMIT_WINDOW_MS) {
    return { window_started_at: now, reservation_count: 0, failure_count: 0, blocked_until: null };
  }
  return row;
}

function saveGuard(
  db: SqliteDatabase,
  scope: GuardScope,
  key: string,
  account: string | null,
  ip: string | null,
  state: GuardRow,
  now: number
): void {
  db.prepare(`
    INSERT INTO login_guards(
      scope, guard_key, account_key, ip_address, window_started_at,
      reservation_count, failure_count, blocked_until, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(scope, guard_key) DO UPDATE SET
      account_key = excluded.account_key,
      ip_address = excluded.ip_address,
      window_started_at = excluded.window_started_at,
      reservation_count = excluded.reservation_count,
      failure_count = excluded.failure_count,
      blocked_until = excluded.blocked_until,
      updated_at = excluded.updated_at
  `).run(
    scope,
    key,
    account,
    ip,
    state.window_started_at,
    state.reservation_count,
    state.failure_count,
    state.blocked_until,
    now
  );
}

function reserveLoginAttempt(db: SqliteDatabase, account: string, ip: string): number | null {
  const now = Date.now();
  return db.transaction(() => {
    const pairKey = pairGuardKey(account, ip);
    const entries = [
      { scope: "ip" as const, key: ip, account: null, ip, limit: IP_ATTEMPT_LIMIT },
      { scope: "ip_account" as const, key: pairKey, account, ip, limit: IP_ACCOUNT_ATTEMPT_LIMIT }
    ];
    const states = entries.map((entry) => ({ entry, state: guardState(db, entry.scope, entry.key, now) }));
    let blockedUntil: number | null = null;
    for (const { entry, state } of states) {
      if (state.blocked_until && state.blocked_until > now) {
        blockedUntil = Math.max(blockedUntil ?? 0, state.blocked_until);
      } else if (state.reservation_count >= entry.limit) {
        state.blocked_until = now + BLOCK_MS;
        blockedUntil = Math.max(blockedUntil ?? 0, state.blocked_until);
        saveGuard(db, entry.scope, entry.key, entry.account, entry.ip, state, now);
      }
    }
    if (blockedUntil) return blockedUntil;
    for (const { entry, state } of states) {
      state.reservation_count += 1;
      saveGuard(db, entry.scope, entry.key, entry.account, entry.ip, state, now);
    }
    return null;
  }).immediate();
}

function recordLoginFailure(db: SqliteDatabase, account: string, ip: string): void {
  const now = Date.now();
  db.transaction(() => {
    const pairKey = pairGuardKey(account, ip);
    for (const entry of [
      { scope: "ip" as const, key: ip, account: null, ip },
      { scope: "ip_account" as const, key: pairKey, account, ip },
      { scope: "account_risk" as const, key: account, account, ip: null }
    ]) {
      const state = guardState(db, entry.scope, entry.key, now);
      state.failure_count += 1;
      saveGuard(db, entry.scope, entry.key, entry.account, entry.ip, state, now);
    }
  }).immediate();
}

function accountRiskDelay(db: SqliteDatabase, account: string): number {
  const now = Date.now();
  const state = guardState(db, "account_risk", account, now);
  return Math.min(750, Math.max(0, state.failure_count - 2) * 75);
}

function delay(milliseconds: number): Promise<void> {
  return milliseconds > 0 ? new Promise((resolve) => setTimeout(resolve, milliseconds)) : Promise.resolve();
}

function getUser(db: SqliteDatabase, username: string): UserRow | undefined {
  return db.prepare("SELECT * FROM users WHERE username = ? COLLATE NOCASE").get(username) as UserRow | undefined;
}

function directAudit(db: SqliteDatabase, request: FastifyRequest, actorId: string, action: string): void {
  db.prepare(`
    INSERT INTO audit_log(actor_user_id, action, target_type, target_id, metadata_json, ip_address, created_at)
    VALUES (?, ?, 'session', NULL, '{}', ?, ?)
  `).run(actorId, action, request.ip, Date.now());
}

export async function registerAuthRoutes(app: FastifyInstance, db: SqliteDatabase, guestSecret: string): Promise<void> {
  const dummyHash = await hashPassword("not-a-real-user-password-123!");

  app.get("/api/auth/session", async (request, reply) => {
    const existing = request.authSession;
    if (!existing?.user) {
      const created = createGuestSession(reply, guestSecret);
      return { user: null, csrfToken: created.csrfToken };
    }
    return { user: toUserDto(existing.user), csrfToken: existing.csrfToken };
  });

  app.post("/api/auth/login", async (request, reply) => {
    const body = objectBody(request.body);
    const usernameRaw = stringField(body, "username", { min: 1, max: 100 })!;
    const password = stringField(body, "password", { min: 1, max: 128, trim: false })!;
    const accountKey = normalizeUsername(usernameRaw).slice(0, 100);
    const ip = request.ip;
    const blocked = reserveLoginAttempt(db, accountKey, ip);
    if (blocked) {
      throw new ApiError(429, "LOGIN_RATE_LIMITED", "Too many login attempts", {
        retryAfterSeconds: Math.max(1, Math.ceil((blocked - Date.now()) / 1000))
      });
    }
    await delay(accountRiskDelay(db, accountKey));

    let normalized = accountKey;
    try {
      normalized = validateUsername(usernameRaw);
    } catch {
      // Unknown and malformed usernames intentionally take the same password-work path.
    }
    const snapshot = getUser(db, normalized);
    const valid = await verifyPassword(snapshot?.password_hash ?? dummyHash, password);
    if (!snapshot || !valid || !snapshot.active) {
      recordLoginFailure(db, accountKey, ip);
      throw new ApiError(401, "INVALID_CREDENTIALS", "Invalid username or password");
    }

    const result = db.transaction(() => {
      const current = getUser(db, normalized);
      if (
        !current ||
        !current.active ||
        current.id !== snapshot.id ||
        current.password_hash !== snapshot.password_hash ||
        current.auth_version !== snapshot.auth_version ||
        current.role !== snapshot.role
      ) return null;
      clearLoginGuards(db, accountKey);
      const now = Date.now();
      db.prepare("UPDATE users SET last_login_at = ?, updated_at = ? WHERE id = ? AND auth_version = ?").run(
        now,
        now,
        current.id,
        current.auth_version
      );
      current.last_login_at = now;
      current.updated_at = now;
      if (request.authSession?.persistent) revokeSession(db, request.authSession.idHash);
      directAudit(db, request, current.id, "auth.login");
      return { user: current, created: createSession(db, reply, request, current) };
    }).immediate();
    if (!result) {
      recordLoginFailure(db, accountKey, ip);
      throw new ApiError(401, "INVALID_CREDENTIALS", "Invalid username or password");
    }
    return { user: toUserDto(result.user), csrfToken: result.created.csrfToken };
  });

  app.post("/api/auth/logout", async (request, reply) => {
    if (request.authSession?.persistent) {
      db.transaction(() => {
        const now = Date.now();
        let finishedPracticeSessions = 0;
        if (request.authSession?.userId) {
          finishedPracticeSessions = db.prepare(`
            UPDATE practice_sessions
            SET finished_at = ?, duration_ms = MAX(duration_ms, ? - started_at)
            WHERE user_id = ? AND finished_at IS NULL
          `).run(now, now, request.authSession.userId).changes;
          audit(db, request, "auth.logout", "session", undefined, { finishedPracticeSessions });
        }
        revokeSession(db, request.authSession!.idHash);
      }).immediate();
    }
    clearSessionCookie(reply);
    return { ok: true };
  });

  app.post("/api/auth/change-password", async (request, reply) => {
    const snapshot = requireUser(request, true);
    const body = objectBody(request.body);
    const currentPassword = stringField(body, "currentPassword", { min: 1, max: 128, trim: false })!;
    const newPasswordValue = stringField(body, "newPassword", { min: 1, max: 128, trim: false })!;
    let newPassword: string;
    try {
      newPassword = validatePassword(newPasswordValue);
    } catch (error) {
      badRequest("INVALID_PASSWORD", (error as Error).message, { field: "newPassword" });
    }
    if (!(await verifyPassword(snapshot.password_hash, currentPassword))) {
      throw new ApiError(401, "CURRENT_PASSWORD_INVALID", "Current password is incorrect");
    }
    if (await verifyPassword(snapshot.password_hash, newPassword!)) {
      badRequest("PASSWORD_UNCHANGED", "New password must be different from the current password");
    }
    const passwordHash = await hashPassword(newPassword!);
    const result = db.transaction(() => {
      const current = revalidateAuthenticatedActor(db, request, snapshot);
      if (current.password_hash !== snapshot.password_hash) {
        throw new ApiError(409, "AUTH_STATE_CHANGED", "Password changed while this request was being processed");
      }
      const now = Date.now();
      const changed = db.prepare(`
        UPDATE users
        SET password_hash = ?, must_change_password = 0, auth_version = auth_version + 1, updated_at = ?
        WHERE id = ? AND auth_version = ? AND password_hash = ?
      `).run(passwordHash, now, current.id, snapshot.auth_version, snapshot.password_hash);
      if (changed.changes !== 1) throw new ApiError(409, "AUTH_STATE_CHANGED", "Authentication state changed");
      revokeUserSessions(db, current.id);
      clearLoginGuards(db, current.username);
      audit(db, request, "auth.password_changed", "user", current.id);
      const updated = getUser(db, current.username)!;
      return { user: updated, created: createSession(db, reply, request, updated) };
    }).immediate();
    return { user: toUserDto(result.user), csrfToken: result.created.csrfToken };
  });
}

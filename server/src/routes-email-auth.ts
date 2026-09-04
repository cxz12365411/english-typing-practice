import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  createSession,
  requireUser,
  revalidateAuthenticatedActor,
  revokeSession,
  revokeUserSessions,
  toUserDto,
  type UserRow
} from "./auth.js";
import type { SqliteDatabase } from "./database.js";
import type { EmailCodePurpose, EmailProvider, VerificationEmail } from "./email-provider.js";
import { ApiError, badRequest, conflict } from "./errors.js";
import {
  emailCodeHash,
  generateEmailCode,
  hashPassword,
  normalizeUsername,
  safeHashEqual,
  tokenHash,
  validateEmail,
  validatePassword,
  validateUsername,
  verifyPassword
} from "./security.js";
import { enumField, objectBody, stringField } from "./validation.js";

const CODE_TTL_MS = 10 * 60_000;
const MAX_CODE_ATTEMPTS = 5;
const REQUEST_WINDOW_MS = 60 * 60_000;
const VERIFY_WINDOW_MS = 15 * 60_000;
const REQUEST_COOLDOWN_MS = 60_000;
const REQUEST_BLOCK_MS = 15 * 60_000;
const EMAIL_REQUEST_DAILY_LIMIT = 10;
const EMAIL_VERIFY_WINDOW_LIMIT = 20;
const BIND_USER_DAILY_LIMIT = 5;
const MAX_PENDING_DELIVERIES = 24;
const DELIVERY_DRAIN_TIMEOUT_MS = 15_000;
const EMAIL_AUTH_BODY_LIMIT = 8 * 1024;

type GuardScope =
  | "request_email"
  | "request_email_day"
  | "request_ip"
  | "request_pair"
  | "verify_email"
  | "verify_ip"
  | "verify_pair"
  | "register_ip_day"
  | "bind_user_day";

interface GuardRow {
  window_started_at: number;
  request_count: number;
  blocked_until: number | null;
  last_request_at: number | null;
}

interface CodeRow {
  id: string;
  email: string;
  purpose: EmailCodePurpose;
  user_id: string | null;
  user_auth_version: number | null;
  code_hash: string;
  created_at: number;
  expires_at: number;
  used_at: number | null;
  attempt_count: number;
  request_ip: string | null;
  request_session_hash: string;
}

interface CodeConsumption<T> {
  ok: boolean;
  value?: T;
}

function emailInput(body: Record<string, unknown>): string {
  try {
    return validateEmail(stringField(body, "email", { min: 3, max: 254 })!);
  } catch (error) {
    badRequest("INVALID_EMAIL", (error as Error).message, { field: "email" });
  }
}

function codeInput(body: Record<string, unknown>): string {
  const code = stringField(body, "code", { min: 1, max: 20, trim: false })!;
  if (!/^\d{6}$/.test(code)) throw invalidCodeError();
  return code;
}

function challengeInput(body: Record<string, unknown>): string {
  const challengeId = stringField(body, "challengeId", { min: 36, max: 36 })!;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(challengeId)) {
    throw invalidCodeError();
  }
  return challengeId.toLowerCase();
}

function requestSessionHash(request: FastifyRequest): string {
  const idHash = request.authSession?.idHash;
  if (!idHash) throw new ApiError(403, "CSRF_INVALID", "Invalid or missing CSRF session");
  return idHash;
}

function invalidCodeError(): ApiError {
  return new ApiError(401, "INVALID_OR_EXPIRED_CODE", "Verification code is invalid or expired");
}

function getUserByVerifiedEmail(db: SqliteDatabase, email: string): UserRow | undefined {
  return db.prepare(`
    SELECT * FROM users
    WHERE email = ? COLLATE NOCASE AND email_verified_at IS NOT NULL
  `).get(email) as UserRow | undefined;
}

function getGuard(db: SqliteDatabase, scope: GuardScope, key: string, now: number, windowMs: number): GuardRow {
  const row = db.prepare(`
    SELECT window_started_at, request_count, blocked_until, last_request_at
    FROM email_auth_guards WHERE scope = ? AND guard_key = ?
  `).get(scope, key) as GuardRow | undefined;
  if (!row || row.window_started_at <= now - windowMs) {
    return { window_started_at: now, request_count: 0, blocked_until: null, last_request_at: null };
  }
  return row;
}

function saveGuard(db: SqliteDatabase, scope: GuardScope, key: string, state: GuardRow, now: number): void {
  db.prepare(`
    INSERT INTO email_auth_guards(
      scope, guard_key, window_started_at, request_count, blocked_until, last_request_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(scope, guard_key) DO UPDATE SET
      window_started_at = excluded.window_started_at,
      request_count = excluded.request_count,
      blocked_until = excluded.blocked_until,
      last_request_at = excluded.last_request_at,
      updated_at = excluded.updated_at
  `).run(scope, key, state.window_started_at, state.request_count, state.blocked_until, state.last_request_at, now);
}

function reserveGuardSet(
  db: SqliteDatabase,
  entries: Array<{ scope: GuardScope; key: string; limit: number; windowMs: number; cooldownMs?: number }>
): number | null {
  const now = Date.now();
  return db.transaction(() => {
    const states = entries.map((entry) => ({ entry, state: getGuard(db, entry.scope, entry.key, now, entry.windowMs) }));
    let retryAt: number | null = null;
    for (const { entry, state } of states) {
      if (state.blocked_until && state.blocked_until > now) {
        retryAt = Math.max(retryAt ?? 0, state.blocked_until);
        continue;
      }
      if (entry.cooldownMs && state.last_request_at && state.last_request_at + entry.cooldownMs > now) {
        retryAt = Math.max(retryAt ?? 0, state.last_request_at + entry.cooldownMs);
        continue;
      }
      if (state.request_count >= entry.limit) {
        state.blocked_until = Math.max(now + REQUEST_BLOCK_MS, state.window_started_at + entry.windowMs);
        retryAt = Math.max(retryAt ?? 0, state.blocked_until);
        saveGuard(db, entry.scope, entry.key, state, now);
      }
    }
    if (retryAt) return retryAt;
    for (const { entry, state } of states) {
      state.request_count += 1;
      state.last_request_at = now;
      saveGuard(db, entry.scope, entry.key, state, now);
    }
    return null;
  }).immediate();
}

function reserveCodeRequest(db: SqliteDatabase, email: string, ip: string): number | null {
  const emailKey = tokenHash(email);
  const pairKey = tokenHash(`${email}\0${ip}`);
  return reserveGuardSet(db, [
    { scope: "request_email", key: emailKey, limit: 5, windowMs: REQUEST_WINDOW_MS, cooldownMs: REQUEST_COOLDOWN_MS },
    {
      scope: "request_email_day",
      key: tokenHash(`${chinaDayKey()}\0${email}`),
      limit: EMAIL_REQUEST_DAILY_LIMIT,
      windowMs: 24 * 60 * 60_000
    },
    { scope: "request_ip", key: ip, limit: 30, windowMs: REQUEST_WINDOW_MS },
    { scope: "request_pair", key: pairKey, limit: 5, windowMs: REQUEST_WINDOW_MS, cooldownMs: REQUEST_COOLDOWN_MS }
  ]);
}

function reserveCodeVerification(db: SqliteDatabase, email: string, ip: string): number | null {
  return reserveGuardSet(db, [
    { scope: "verify_email", key: tokenHash(email), limit: EMAIL_VERIFY_WINDOW_LIMIT, windowMs: VERIFY_WINDOW_MS },
    { scope: "verify_ip", key: ip, limit: 60, windowMs: VERIFY_WINDOW_MS },
    { scope: "verify_pair", key: tokenHash(`${email}\0${ip}`), limit: 10, windowMs: VERIFY_WINDOW_MS }
  ]);
}

function reserveRegistrationRequest(db: SqliteDatabase, ip: string, limit: number): number | null {
  return reserveGuardSet(db, [
    {
      scope: "register_ip_day",
      key: tokenHash(`${chinaDayKey()}\0${ip}`),
      limit,
      windowMs: 24 * 60 * 60_000
    }
  ]);
}

function reserveBindRequest(db: SqliteDatabase, userId: string): number | null {
  return reserveGuardSet(db, [
    {
      scope: "bind_user_day",
      key: tokenHash(`${chinaDayKey()}\0${userId}`),
      limit: BIND_USER_DAILY_LIMIT,
      windowMs: 24 * 60 * 60_000
    }
  ]);
}

function throwRateLimit(blockedUntil: number): never {
  throw new ApiError(429, "EMAIL_RATE_LIMITED", "Too many email verification attempts", {
    retryAfterSeconds: Math.max(1, Math.ceil((blockedUntil - Date.now()) / 1000))
  });
}

function directAudit(
  db: SqliteDatabase,
  request: FastifyRequest,
  actorId: string | null,
  action: string,
  targetId?: string
): void {
  db.prepare(`
    INSERT INTO audit_log(actor_user_id, action, target_type, target_id, metadata_json, ip_address, created_at)
    VALUES (?, ?, 'user', ?, '{}', ?, ?)
  `).run(actorId, action, targetId ?? actorId, request.ip, Date.now());
}

function codeById(
  db: SqliteDatabase,
  id: string,
  email: string,
  purpose: EmailCodePurpose,
  expectedUserId: string | null,
  expectedSessionHash: string
): CodeRow | undefined {
  return db.prepare(`
    SELECT * FROM email_verification_codes
    WHERE id = ? AND email = ? COLLATE NOCASE AND purpose = ?
      AND request_session_hash = ?
      AND ((? IS NULL AND user_id IS NULL) OR user_id = ?)
    LIMIT 1
  `).get(id, email, purpose, expectedSessionHash, expectedUserId, expectedUserId) as CodeRow | undefined;
}

function codeRowIsValid(
  row: CodeRow | undefined,
  secret: string,
  email: string,
  purpose: EmailCodePurpose,
  expectedAuthVersion: number | null,
  code: string,
  now: number
): boolean {
  const expectedHash = row?.code_hash ?? emailCodeHash(secret, "missing", email, purpose, "000000");
  const actualHash = emailCodeHash(secret, row?.id ?? "missing", email, purpose, code);
  return Boolean(
    row &&
    row.used_at === null &&
    row.expires_at > now &&
    row.attempt_count < MAX_CODE_ATTEMPTS &&
    row.user_auth_version === expectedAuthVersion &&
    safeHashEqual(actualHash, expectedHash)
  );
}

function recordInvalidCodeAttempt(db: SqliteDatabase, row: CodeRow | undefined, now: number): void {
  if (!row || row.used_at !== null || row.expires_at <= now || row.attempt_count >= MAX_CODE_ATTEMPTS) return;
  const nextAttempts = row.attempt_count + 1;
  db.prepare(`
    UPDATE email_verification_codes
    SET attempt_count = ?, used_at = CASE WHEN ? >= ? THEN ? ELSE used_at END
    WHERE id = ? AND used_at IS NULL
  `).run(nextAttempts, nextAttempts, MAX_CODE_ATTEMPTS, now, row.id);
}

function assertCodeCandidate(
  db: SqliteDatabase,
  secret: string,
  email: string,
  purpose: EmailCodePurpose,
  expectedUserId: string | null,
  expectedAuthVersion: number | null,
  challengeId: string,
  expectedSessionHash: string,
  code: string
): string {
  const codeId = db.transaction(() => {
    const now = Date.now();
    const row = codeById(db, challengeId, email, purpose, expectedUserId, expectedSessionHash);
    if (codeRowIsValid(row, secret, email, purpose, expectedAuthVersion, code, now)) return row!.id;
    recordInvalidCodeAttempt(db, row, now);
    return null;
  }).immediate();
  if (!codeId) throw invalidCodeError();
  return codeId;
}

function consumeCode<T>(
  db: SqliteDatabase,
  secret: string,
  email: string,
  purpose: EmailCodePurpose,
  expectedUserId: string | null,
  expectedAuthVersion: number | null,
  expectedCodeId: string,
  expectedSessionHash: string,
  code: string,
  onValid: (row: CodeRow) => T
): T {
  const result = db.transaction((): CodeConsumption<T> => {
    const now = Date.now();
    const row = codeById(db, expectedCodeId, email, purpose, expectedUserId, expectedSessionHash);
    const valid = codeRowIsValid(row, secret, email, purpose, expectedAuthVersion, code, now);
    if (!valid) {
      recordInvalidCodeAttempt(db, row, now);
      return { ok: false };
    }
    const consumed = db.prepare(`
      UPDATE email_verification_codes SET used_at = ?
      WHERE id = ? AND used_at IS NULL AND expires_at > ? AND attempt_count < ?
    `).run(now, row!.id, now, MAX_CODE_ATTEMPTS);
    if (consumed.changes !== 1) return { ok: false };
    const value = onValid(row!);
    return { ok: true, value };
  }).immediate();
  if (!result.ok) throw invalidCodeError();
  return result.value as T;
}

function issueCode(
  db: SqliteDatabase,
  secret: string,
  email: string,
  purpose: EmailCodePurpose,
  userId: string | null,
  userAuthVersion: number | null,
  ip: string,
  sessionHash: string
): { row: CodeRow; code: string } {
  const id = randomUUID();
  const code = generateEmailCode();
  const createdAt = Date.now();
  const expiresAt = createdAt + CODE_TTL_MS;
  const codeHash = emailCodeHash(secret, id, email, purpose, code);
  db.prepare(`
    INSERT INTO email_verification_codes(
      id, email, purpose, user_id, user_auth_version, code_hash, created_at, expires_at,
      request_ip, request_session_hash
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, email, purpose, userId, userAuthVersion, codeHash, createdAt, expiresAt, ip, sessionHash);
  return {
    code,
    row: {
      id,
      email,
      purpose,
      user_id: userId,
      user_auth_version: userAuthVersion,
      code_hash: codeHash,
      created_at: createdAt,
      expires_at: expiresAt,
      used_at: null,
      attempt_count: 0,
      request_ip: ip,
      request_session_hash: sessionHash
    }
  };
}

function createAuthenticatedResponse(
  db: SqliteDatabase,
  reply: FastifyReply,
  request: FastifyRequest,
  user: UserRow
): { user: ReturnType<typeof toUserDto>; csrfToken: string } {
  if (request.authSession?.persistent) revokeSession(db, request.authSession.idHash);
  const created = createSession(db, reply, request, user);
  return { user: toUserDto(user), csrfToken: created.csrfToken };
}

export interface EmailAuthCapabilities {
  emailAuthEnabled: boolean;
  selfRegistrationEnabled: boolean;
}

export interface EmailAuthOptions {
  selfRegistrationEnabled: boolean;
  dailySendLimit: number;
  registrationDailySendLimit: number;
  registrationIpDailyLimit: number;
}

export function emailAuthCapabilities(provider: EmailProvider, options: EmailAuthOptions): EmailAuthCapabilities {
  return {
    emailAuthEnabled: provider.enabled,
    selfRegistrationEnabled: provider.enabled && options.selfRegistrationEnabled
  };
}

function chinaDayKey(now = Date.now()): string {
  return new Date(now + 8 * 60 * 60_000).toISOString().slice(0, 10);
}

function dailyCapacityAvailable(db: SqliteDatabase, limit: number, registrationLimit: number, registration: boolean): boolean {
  const row = db.prepare("SELECT send_count, registration_send_count FROM email_send_daily WHERE day_key = ?").get(chinaDayKey()) as
    | { send_count: number; registration_send_count: number }
    | undefined;
  return (row?.send_count ?? 0) < limit && (!registration || (row?.registration_send_count ?? 0) < registrationLimit);
}

function reserveDailySend(db: SqliteDatabase, limit: number, registrationLimit: number, registration: boolean): boolean {
  const now = Date.now();
  const day = chinaDayKey(now);
  return db.transaction(() => {
    db.prepare(`
      INSERT INTO email_send_daily(day_key, send_count, registration_send_count, updated_at) VALUES (?, 0, 0, ?)
      ON CONFLICT(day_key) DO NOTHING
    `).run(day, now);
    return db.prepare(`
      UPDATE email_send_daily
      SET send_count = send_count + 1,
          registration_send_count = registration_send_count + ?,
          updated_at = ?
      WHERE day_key = ? AND send_count < ?
        AND (? = 0 OR registration_send_count < ?)
    `).run(registration ? 1 : 0, now, day, limit, registration ? 1 : 0, registrationLimit).changes === 1;
  }).immediate();
}

export async function registerEmailAuthRoutes(
  app: FastifyInstance,
  db: SqliteDatabase,
  provider: EmailProvider,
  codeSecret: string,
  options: EmailAuthOptions
): Promise<() => Promise<void>> {
  const pendingDeliveries = new Set<Promise<void>>();
  const pendingCodeIds = new Map<Promise<void>, string>();
  let closing = false;
  const dispatch = (message: VerificationEmail, codeId: string, purpose: EmailCodePurpose, request: FastifyRequest): void => {
    const task = provider.sendVerificationCode(message).catch(() => {
      if (!closing) {
        db.prepare("DELETE FROM email_verification_codes WHERE id = ? AND used_at IS NULL").run(codeId);
        request.log.error({ purpose }, "Verification email delivery failed");
      }
    });
    pendingDeliveries.add(task);
    pendingCodeIds.set(task, codeId);
    void task.finally(() => {
      pendingDeliveries.delete(task);
      pendingCodeIds.delete(task);
    });
  };

  const closeEmailAuth = async (): Promise<void> => {
    let drainTimer: NodeJS.Timeout | undefined;
    await Promise.race([
      Promise.allSettled([...pendingDeliveries]),
      new Promise<void>((resolve) => {
        drainTimer = setTimeout(resolve, DELIVERY_DRAIN_TIMEOUT_MS);
        drainTimer.unref();
      })
    ]);
    if (drainTimer) clearTimeout(drainTimer);
    closing = true;
    const unfinishedIds = [...pendingCodeIds.values()];
    if (unfinishedIds.length) {
      const discard = db.prepare("DELETE FROM email_verification_codes WHERE id = ? AND used_at IS NULL");
      db.transaction(() => unfinishedIds.forEach((id) => discard.run(id)))();
    }
    await provider.close?.();
  };

  app.post("/api/auth/email/request-code", { bodyLimit: EMAIL_AUTH_BODY_LIMIT }, async (request, reply) => {
    const body = objectBody(request.body);
    const email = emailInput(body);
    const purpose = enumField(body, "purpose", ["register", "login", "reset_password", "bind_email"] as const)!;
    const requesterSessionHash = requestSessionHash(request);
    let challengeId: string = randomUUID();
    if (!provider.enabled) {
      throw new ApiError(503, "EMAIL_DELIVERY_UNAVAILABLE", "Email verification is not configured");
    }
    if (purpose === "register" && !options.selfRegistrationEnabled) {
      throw new ApiError(403, "SELF_REGISTRATION_DISABLED", "Self-registration is disabled");
    }
    if (pendingDeliveries.size >= MAX_PENDING_DELIVERIES) {
      throw new ApiError(429, "EMAIL_RATE_LIMITED", "Email delivery is busy", { retryAfterSeconds: 5 });
    }
    const actor = purpose === "bind_email" ? requireUser(request) : null;
    if (actor?.email) conflict("EMAIL_ALREADY_BOUND", "This account already has a verified email address");
    const registrationRequest = purpose === "register";
    if (!dailyCapacityAvailable(db, options.dailySendLimit, options.registrationDailySendLimit, registrationRequest)) {
      throw new ApiError(429, "EMAIL_DAILY_LIMIT_REACHED", "Daily verification email limit reached");
    }
    const blocked = reserveCodeRequest(db, email, request.ip);
    if (blocked) throwRateLimit(blocked);
    if (registrationRequest) {
      const registrationBlocked = reserveRegistrationRequest(db, request.ip, options.registrationIpDailyLimit);
      if (registrationBlocked) throwRateLimit(registrationBlocked);
    }
    if (purpose === "bind_email" && actor) {
      const bindBlocked = reserveBindRequest(db, actor.id);
      if (bindBlocked) throwRateLimit(bindBlocked);
    }

    const verifiedUser = getUserByVerifiedEmail(db, email);
    const emailTaken = Boolean(db.prepare("SELECT 1 FROM users WHERE email = ? COLLATE NOCASE").get(email));
    const eligible =
      purpose === "register" ? !emailTaken :
      purpose === "bind_email" ? Boolean(actor && !emailTaken) :
      Boolean(verifiedUser?.active);
    const userId = purpose === "bind_email" ? actor?.id ?? null : (purpose === "register" ? null : verifiedUser?.id ?? null);
    const userAuthVersion = purpose === "bind_email"
      ? actor?.auth_version ?? null
      : (purpose === "register" ? null : verifiedUser?.auth_version ?? null);

    if (eligible) {
      if (!reserveDailySend(
        db,
        options.dailySendLimit,
        options.registrationDailySendLimit,
        registrationRequest
      )) {
        throw new ApiError(429, "EMAIL_DAILY_LIMIT_REACHED", "Daily verification email limit reached");
      }
      const issued = issueCode(
        db,
        codeSecret,
        email,
        purpose,
        userId,
        userAuthVersion,
        request.ip,
        requesterSessionHash
      );
      challengeId = issued.row.id;
      dispatch(
        { to: email, code: issued.code, purpose, expiresAt: issued.row.expires_at },
        issued.row.id,
        purpose,
        request
      );
    }
    return reply.status(202).send({
      ok: true,
      challengeId,
      expiresInSeconds: CODE_TTL_MS / 1000,
      retryAfterSeconds: REQUEST_COOLDOWN_MS / 1000
    });
  });

  app.post("/api/auth/email/register", { bodyLimit: EMAIL_AUTH_BODY_LIMIT }, async (request, reply) => {
    if (!provider.enabled) throw new ApiError(503, "EMAIL_DELIVERY_UNAVAILABLE", "Email verification is not configured");
    if (!options.selfRegistrationEnabled) {
      throw new ApiError(403, "SELF_REGISTRATION_DISABLED", "Self-registration is disabled");
    }
    const body = objectBody(request.body);
    const email = emailInput(body);
    const code = codeInput(body);
    const challengeId = challengeInput(body);
    const sessionHash = requestSessionHash(request);
    let username: string;
    let password: string;
    try {
      username = validateUsername(stringField(body, "username", { min: 3, max: 32 })!);
    } catch (error) {
      badRequest("INVALID_USERNAME", (error as Error).message, { field: "username" });
    }
    try {
      password = validatePassword(stringField(body, "password", { min: 1, max: 128, trim: false })!);
    } catch (error) {
      badRequest("INVALID_PASSWORD", (error as Error).message, { field: "password" });
    }
    const displayName = stringField(body, "displayName", { min: 1, max: 80 })!;
    const blocked = reserveCodeVerification(db, email, request.ip);
    if (blocked) throwRateLimit(blocked);
    const candidateCodeId = assertCodeCandidate(
      db,
      codeSecret,
      email,
      "register",
      null,
      null,
      challengeId,
      sessionHash,
      code
    );
    const passwordHash = await hashPassword(password!);
    const created = consumeCode(db, codeSecret, email, "register", null, null, candidateCodeId, sessionHash, code, () => {
      if (db.prepare("SELECT 1 FROM users WHERE username = ? COLLATE NOCASE").get(username!)) {
        conflict("USERNAME_EXISTS", "Username already exists");
      }
      if (db.prepare("SELECT 1 FROM users WHERE email = ? COLLATE NOCASE").get(email)) {
        conflict("EMAIL_EXISTS", "Email address is already registered");
      }
      const id = randomUUID();
      const now = Date.now();
      db.prepare(`
        INSERT INTO users(
          id, username, display_name, password_hash, role, active, must_change_password,
          created_at, updated_at, email, email_verified_at
        ) VALUES (?, ?, ?, ?, 'user', 1, 0, ?, ?, ?, ?)
      `).run(id, username!, displayName, passwordHash, now, now, email, now);
      const user = db.prepare("SELECT * FROM users WHERE id = ?").get(id) as UserRow;
      directAudit(db, request, id, "auth.email_registered", id);
      return createAuthenticatedResponse(db, reply, request, user);
    });
    return created;
  });

  app.post("/api/auth/email/login", { bodyLimit: EMAIL_AUTH_BODY_LIMIT }, async (request, reply) => {
    if (!provider.enabled) throw new ApiError(503, "EMAIL_DELIVERY_UNAVAILABLE", "Email verification is not configured");
    const body = objectBody(request.body);
    const email = emailInput(body);
    const code = codeInput(body);
    const challengeId = challengeInput(body);
    const sessionHash = requestSessionHash(request);
    const blocked = reserveCodeVerification(db, email, request.ip);
    if (blocked) throwRateLimit(blocked);
    const snapshot = getUserByVerifiedEmail(db, email);
    const response = consumeCode(
      db,
      codeSecret,
      email,
      "login",
      snapshot?.id ?? "missing-user",
      snapshot?.auth_version ?? -1,
      challengeId,
      sessionHash,
      code,
      () => {
      const user = getUserByVerifiedEmail(db, email);
      if (!snapshot || !user || user.id !== snapshot.id || !user.active || user.auth_version !== snapshot.auth_version) {
        return null;
      }
      const now = Date.now();
      db.prepare("UPDATE users SET last_login_at = ?, updated_at = ? WHERE id = ? AND auth_version = ?").run(
        now,
        now,
        user.id,
        user.auth_version
      );
      user.last_login_at = now;
      user.updated_at = now;
      directAudit(db, request, user.id, "auth.email_login", user.id);
      return createAuthenticatedResponse(db, reply, request, user);
      }
    );
    if (!response) throw invalidCodeError();
    return response;
  });

  app.post("/api/auth/email/reset-password", { bodyLimit: EMAIL_AUTH_BODY_LIMIT }, async (request, reply) => {
    if (!provider.enabled) throw new ApiError(503, "EMAIL_DELIVERY_UNAVAILABLE", "Email verification is not configured");
    const body = objectBody(request.body);
    const email = emailInput(body);
    const code = codeInput(body);
    const challengeId = challengeInput(body);
    const sessionHash = requestSessionHash(request);
    let newPassword: string;
    try {
      newPassword = validatePassword(stringField(body, "newPassword", { min: 1, max: 128, trim: false })!);
    } catch (error) {
      badRequest("INVALID_PASSWORD", (error as Error).message, { field: "newPassword" });
    }
    const blocked = reserveCodeVerification(db, email, request.ip);
    if (blocked) throwRateLimit(blocked);
    const snapshot = getUserByVerifiedEmail(db, email);
    const candidateCodeId = assertCodeCandidate(
      db,
      codeSecret,
      email,
      "reset_password",
      snapshot?.id ?? "missing-user",
      snapshot?.auth_version ?? -1,
      challengeId,
      sessionHash,
      code
    );
    const passwordHash = await hashPassword(newPassword!);
    const response = consumeCode(
      db,
      codeSecret,
      email,
      "reset_password",
      snapshot?.id ?? "missing-user",
      snapshot?.auth_version ?? -1,
      candidateCodeId,
      sessionHash,
      code,
      () => {
      const user = getUserByVerifiedEmail(db, email);
      if (!snapshot || !user || user.id !== snapshot.id || !user.active || user.auth_version !== snapshot.auth_version) {
        return null;
      }
      const now = Date.now();
      const updated = db.prepare(`
        UPDATE users
        SET password_hash = ?, must_change_password = 0, auth_version = auth_version + 1, updated_at = ?
        WHERE id = ? AND auth_version = ?
      `).run(passwordHash, now, user.id, snapshot.auth_version);
      if (updated.changes !== 1) return null;
      revokeUserSessions(db, user.id);
      db.prepare("DELETE FROM login_guards WHERE account_key = ?").run(normalizeUsername(user.username));
      const current = db.prepare("SELECT * FROM users WHERE id = ?").get(user.id) as UserRow;
      directAudit(db, request, current.id, "auth.email_password_reset", current.id);
      return createAuthenticatedResponse(db, reply, request, current);
      }
    );
    if (!response) throw invalidCodeError();
    return response;
  });

  app.post("/api/auth/email/bind", { bodyLimit: EMAIL_AUTH_BODY_LIMIT }, async (request, reply) => {
    if (!provider.enabled) throw new ApiError(503, "EMAIL_DELIVERY_UNAVAILABLE", "Email verification is not configured");
    const actor = requireUser(request);
    if (actor.email) conflict("EMAIL_ALREADY_BOUND", "This account already has a verified email address");
    const body = objectBody(request.body);
    const email = emailInput(body);
    const code = codeInput(body);
    const challengeId = challengeInput(body);
    const sessionHash = requestSessionHash(request);
    const currentPassword = stringField(body, "currentPassword", { min: 1, max: 128, trim: false })!;
    const blocked = reserveCodeVerification(db, email, request.ip);
    if (blocked) throwRateLimit(blocked);
    const candidateCodeId = assertCodeCandidate(
      db,
      codeSecret,
      email,
      "bind_email",
      actor.id,
      actor.auth_version,
      challengeId,
      sessionHash,
      code
    );
    if (!(await verifyPassword(actor.password_hash, currentPassword))) {
      throw new ApiError(401, "CURRENT_PASSWORD_INVALID", "Current password is incorrect");
    }
    const response = consumeCode(
      db,
      codeSecret,
      email,
      "bind_email",
      actor.id,
      actor.auth_version,
      candidateCodeId,
      sessionHash,
      code,
      () => {
      const current = revalidateAuthenticatedActor(db, request, actor);
      if (
        current.email ||
        current.password_hash !== actor.password_hash ||
        db.prepare("SELECT 1 FROM users WHERE email = ? COLLATE NOCASE").get(email)
      ) return null;
      const now = Date.now();
      const updated = db.prepare(`
        UPDATE users
        SET email = ?, email_verified_at = ?, auth_version = auth_version + 1, updated_at = ?
        WHERE id = ? AND email IS NULL AND auth_version = ?
      `).run(email, now, now, current.id, actor.auth_version);
      if (updated.changes !== 1) return null;
      revokeUserSessions(db, current.id);
      const bound = db.prepare("SELECT * FROM users WHERE id = ?").get(current.id) as UserRow;
      directAudit(db, request, bound.id, "auth.email_bound", bound.id);
      return createAuthenticatedResponse(db, reply, request, bound);
      }
    );
    if (!response) throw invalidCodeError();
    return response;
  });
  return closeEmailAuth;
}

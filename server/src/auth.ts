import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { SqliteDatabase } from "./database.js";
import { ApiError } from "./errors.js";
import { randomToken, safeTokenEqual, tokenHash } from "./security.js";

export const SESSION_COOKIE = "__Host-etp_session";
const GUEST_LIFETIME = 15 * 60_000;
const USER_IDLE = 24 * 60 * 60_000;
const USER_ABSOLUTE = 7 * 24 * 60 * 60_000;
const ADMIN_IDLE = 30 * 60_000;
const ADMIN_ABSOLUTE = 8 * 60 * 60_000;
const MAX_ACTIVE_USER_SESSIONS = 10;

export interface UserRow {
  id: string;
  username: string;
  display_name: string;
  password_hash: string;
  role: "user" | "admin";
  active: number;
  must_change_password: number;
  auth_version: number;
  created_at: number;
  updated_at: number;
  last_login_at: number | null;
}

interface SessionJoinRow extends UserRow {
  session_id_hash: string;
  session_auth_version: number | null;
  csrf_token: string;
  csrf_hash: string;
  user_id: string | null;
  session_created_at: number;
  last_seen_at: number;
  expires_at: number;
  absolute_expires_at: number;
  revoked_at: number | null;
}

export interface AuthSession {
  persistent: boolean;
  idHash: string;
  csrfToken: string;
  csrfHash: string;
  userId: string | null;
  createdAt: number;
  lastSeenAt: number;
  expiresAt: number;
  absoluteExpiresAt: number;
  authVersion: number | null;
  user: UserRow | null;
}

export interface UserDto {
  id: string;
  username: string;
  displayName: string;
  role: "user" | "admin";
  status: "active" | "disabled";
  mustChangePassword: boolean;
  lastLoginAt?: string;
  createdAt: string;
}

export function toUserDto(user: UserRow): UserDto {
  return {
    id: user.id,
    username: user.username,
    displayName: user.display_name,
    role: user.role,
    status: user.active ? "active" : "disabled",
    mustChangePassword: Boolean(user.must_change_password),
    ...(user.last_login_at ? { lastLoginAt: new Date(user.last_login_at).toISOString() } : {}),
    createdAt: new Date(user.created_at).toISOString()
  };
}

function idleAndAbsolute(role: "user" | "admin"): [number, number] {
  if (role === "admin") return [ADMIN_IDLE, ADMIN_ABSOLUTE];
  return [USER_IDLE, USER_ABSOLUTE];
}

function cookieOptions(maxAgeMs: number) {
  return {
    path: "/",
    secure: true,
    httpOnly: true,
    sameSite: "lax" as const,
    maxAge: Math.max(1, Math.floor(maxAgeMs / 1000))
  };
}

export function clearSessionCookie(reply: FastifyReply): void {
  reply.clearCookie(SESSION_COOKIE, cookieOptions(1));
}

export function createSession(
  db: SqliteDatabase,
  reply: FastifyReply,
  request: FastifyRequest,
  user: UserRow
): { csrfToken: string; session: AuthSession } {
  const sessionToken = randomToken();
  const csrfToken = randomToken();
  const now = Date.now();
  const [idle, absolute] = idleAndAbsolute(user.role);
  const absoluteExpiresAt = now + absolute;
  const expiresAt = Math.min(now + idle, absoluteExpiresAt);
  const idHash = tokenHash(sessionToken);
  const csrfHash = tokenHash(csrfToken);
  db.prepare("DELETE FROM sessions WHERE user_id = ? AND (expires_at <= ? OR absolute_expires_at <= ? OR revoked_at IS NOT NULL)").run(
    user.id,
    now,
    now
  );
  const stale = db.prepare(`
    SELECT id_hash FROM sessions
    WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ? AND absolute_expires_at > ?
    ORDER BY created_at DESC, id_hash DESC
    LIMIT -1 OFFSET ?
  `).all(user.id, now, now, MAX_ACTIVE_USER_SESSIONS - 1) as Array<{ id_hash: string }>;
  const revoke = db.prepare("UPDATE sessions SET revoked_at = ? WHERE id_hash = ?");
  for (const row of stale) revoke.run(now, row.id_hash);
  db.prepare(`
    INSERT INTO sessions(
      id_hash, csrf_token, csrf_hash, user_id, auth_version, created_at, last_seen_at, expires_at, absolute_expires_at,
      ip_address, user_agent
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    idHash,
    csrfToken,
    csrfHash,
    user.id,
    user.auth_version,
    now,
    now,
    expiresAt,
    absoluteExpiresAt,
    request.ip,
    String(request.headers["user-agent"] ?? "").slice(0, 500)
  );
  reply.setCookie(SESSION_COOKIE, sessionToken, cookieOptions(absolute));
  return {
    csrfToken,
    session: {
      persistent: true,
      idHash,
      csrfToken,
      csrfHash,
      userId: user.id,
      createdAt: now,
      lastSeenAt: now,
      expiresAt,
      absoluteExpiresAt,
      authVersion: user.auth_version,
      user
    }
  };
}

function guestSignature(secret: string, payload: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

function equalSignature(actual: string, expected: string): boolean {
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

export function createGuestSession(
  reply: FastifyReply,
  secret: string
): { csrfToken: string; session: AuthSession } {
  const now = Date.now();
  const expiresAt = now + GUEST_LIFETIME;
  const csrfToken = randomToken();
  const payload = Buffer.from(JSON.stringify({ iat: now, exp: expiresAt, csrf: tokenHash(csrfToken) })).toString("base64url");
  const rawToken = `g.${payload}.${guestSignature(secret, payload)}`;
  reply.setCookie(SESSION_COOKIE, rawToken, cookieOptions(GUEST_LIFETIME));
  return {
    csrfToken,
    session: {
      persistent: false,
      idHash: tokenHash(rawToken),
      csrfToken,
      csrfHash: tokenHash(csrfToken),
      userId: null,
      createdAt: now,
      lastSeenAt: now,
      expiresAt,
      absoluteExpiresAt: expiresAt,
      authVersion: null,
      user: null
    }
  };
}

function loadGuestSession(rawToken: string, secret: string): AuthSession | null {
  const parts = rawToken.split(".");
  if (parts.length !== 3 || parts[0] !== "g" || !equalSignature(parts[2]!, guestSignature(secret, parts[1]!))) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8")) as {
      iat?: unknown;
      exp?: unknown;
      csrf?: unknown;
    };
    const now = Date.now();
    if (
      !Number.isSafeInteger(payload.iat) ||
      !Number.isSafeInteger(payload.exp) ||
      typeof payload.csrf !== "string" ||
      payload.csrf.length !== 64 ||
      (payload.iat as number) > now + 60_000 ||
      (payload.exp as number) <= now ||
      (payload.exp as number) - (payload.iat as number) !== GUEST_LIFETIME
    ) return null;
    return {
      persistent: false,
      idHash: tokenHash(rawToken),
      csrfToken: "",
      csrfHash: payload.csrf,
      userId: null,
      createdAt: payload.iat as number,
      lastSeenAt: now,
      expiresAt: payload.exp as number,
      absoluteExpiresAt: payload.exp as number,
      authVersion: null,
      user: null
    };
  } catch {
    return null;
  }
}

export function revokeSession(db: SqliteDatabase, idHash: string): void {
  db.prepare("UPDATE sessions SET revoked_at = COALESCE(revoked_at, ?) WHERE id_hash = ?").run(Date.now(), idHash);
}

export function revokeUserSessions(db: SqliteDatabase, userId: string): number {
  return db.prepare("UPDATE sessions SET revoked_at = COALESCE(revoked_at, ?) WHERE user_id = ? AND revoked_at IS NULL").run(Date.now(), userId).changes;
}

export function loadSession(db: SqliteDatabase, request: FastifyRequest, reply: FastifyReply, guestSecret: string): AuthSession | null {
  const rawToken = request.cookies[SESSION_COOKIE];
  if (!rawToken || rawToken.length > 512) return null;
  if (rawToken.startsWith("g.")) {
    const guest = loadGuestSession(rawToken, guestSecret);
    if (!guest) clearSessionCookie(reply);
    return guest;
  }
  const idHash = tokenHash(rawToken);
  const row = db.prepare(`
    SELECT
      s.id_hash AS session_id_hash, s.csrf_token, s.csrf_hash, s.user_id, s.auth_version AS session_auth_version,
      s.created_at AS session_created_at, s.last_seen_at, s.expires_at, s.absolute_expires_at, s.revoked_at,
      u.id, u.username, u.display_name, u.password_hash, u.role, u.active,
      u.must_change_password, u.auth_version, u.created_at, u.updated_at, u.last_login_at
    FROM sessions s
    LEFT JOIN users u ON u.id = s.user_id
    WHERE s.id_hash = ?
  `).get(idHash) as SessionJoinRow | undefined;
  const now = Date.now();
  if (
    !row ||
    row.revoked_at ||
    row.expires_at <= now ||
    row.absolute_expires_at <= now ||
    !row.user_id ||
    !row.id ||
    !row.active ||
    row.session_auth_version !== row.auth_version
  ) {
    if (row) db.prepare("DELETE FROM sessions WHERE id_hash = ?").run(idHash);
    clearSessionCookie(reply);
    return null;
  }
  const user: UserRow = {
    id: row.id,
    username: row.username,
    display_name: row.display_name,
    password_hash: row.password_hash,
    role: row.role,
    active: row.active,
    must_change_password: row.must_change_password,
    auth_version: row.auth_version,
    created_at: row.created_at,
    updated_at: row.updated_at,
    last_login_at: row.last_login_at
  };
  const [idle] = idleAndAbsolute(user.role);
  const expiresAt = Math.min(now + idle, row.absolute_expires_at);
  if (now - row.last_seen_at >= 60_000) {
    db.prepare("UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE id_hash = ?").run(now, expiresAt, idHash);
  }
  return {
    persistent: true,
    idHash,
    csrfToken: row.csrf_token,
    csrfHash: row.csrf_hash,
    userId: row.user_id,
    createdAt: row.session_created_at,
    lastSeenAt: now,
    expiresAt,
    absoluteExpiresAt: row.absolute_expires_at,
    authVersion: row.session_auth_version,
    user
  };
}

export function requireCsrf(request: FastifyRequest): void {
  const session = request.authSession;
  const csrf = request.headers["x-csrf-token"];
  if (!session || typeof csrf !== "string" || !safeTokenEqual(csrf, session.csrfHash)) {
    throw new ApiError(403, "CSRF_INVALID", "Invalid or missing CSRF token");
  }
}

export function requireUser(request: FastifyRequest, allowPasswordChange = false): UserRow {
  const user = request.authSession?.user;
  if (!user) throw new ApiError(401, "AUTH_REQUIRED", "Authentication required");
  if (!user.active) throw new ApiError(401, "ACCOUNT_DISABLED", "Account is disabled");
  if (user.must_change_password && !allowPasswordChange) {
    throw new ApiError(403, "MUST_CHANGE_PASSWORD", "Password must be changed before continuing");
  }
  return user;
}

export function requireAdmin(request: FastifyRequest): UserRow {
  const user = requireUser(request);
  if (user.role !== "admin") throw new ApiError(403, "ADMIN_REQUIRED", "Administrator access required");
  return user;
}

export function revalidateAuthenticatedActor(
  db: SqliteDatabase,
  request: FastifyRequest,
  expected: UserRow,
  requiredRole?: "admin"
): UserRow {
  const session = request.authSession;
  if (!session?.persistent || !session.userId || session.userId !== expected.id) {
    throw new ApiError(401, "AUTH_STATE_CHANGED", "Authentication state changed; sign in again");
  }
  const row = db.prepare(`
    SELECT u.*
    FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.id_hash = ? AND s.user_id = ? AND s.revoked_at IS NULL
      AND s.expires_at > ? AND s.absolute_expires_at > ?
      AND s.auth_version = u.auth_version
  `).get(session.idHash, expected.id, Date.now(), Date.now()) as UserRow | undefined;
  if (
    !row ||
    !row.active ||
    row.auth_version !== expected.auth_version ||
    row.role !== expected.role ||
    (requiredRole === "admin" && row.role !== "admin")
  ) {
    throw new ApiError(409, "AUTH_STATE_CHANGED", "Authentication state changed; retry after signing in again");
  }
  return row;
}

export function clearLoginGuards(db: SqliteDatabase, accountKey: string): number {
  return db.prepare("DELETE FROM login_guards WHERE account_key = ?").run(accountKey).changes;
}

export function audit(
  db: SqliteDatabase,
  request: FastifyRequest,
  action: string,
  targetType?: string,
  targetId?: string,
  metadata: Record<string, unknown> = {}
): void {
  db.prepare(`
    INSERT INTO audit_log(actor_user_id, action, target_type, target_id, metadata_json, ip_address, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    request.authSession?.userId ?? null,
    action,
    targetType ?? null,
    targetId ?? null,
    JSON.stringify(metadata),
    request.ip,
    Date.now()
  );
}

export function cleanupExpiredSecurityRows(db: SqliteDatabase): void {
  const now = Date.now();
  db.prepare("DELETE FROM sessions WHERE absolute_expires_at < ? OR (revoked_at IS NOT NULL AND revoked_at < ?)").run(
    now,
    now - 7 * 24 * 60 * 60_000
  );
  db.prepare("DELETE FROM login_limits WHERE updated_at < ?").run(now - 7 * 24 * 60 * 60_000);
  db.prepare("DELETE FROM login_guards WHERE updated_at < ?").run(now - 7 * 24 * 60 * 60_000);
  db.prepare("DELETE FROM import_previews WHERE expires_at < ?").run(now);
  db.prepare("DELETE FROM attempts WHERE created_at < ?").run(now - 90 * 24 * 60 * 60_000);
  db.prepare(`
    UPDATE practice_sessions
    SET finished_at = ?, duration_ms = MAX(duration_ms, ? - started_at)
    WHERE finished_at IS NULL AND started_at < ?
  `).run(now, now, now - 24 * 60 * 60_000);
}

export function createId(): string {
  return randomUUID();
}

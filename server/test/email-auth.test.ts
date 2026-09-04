import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import type { UserRow } from "../src/auth.js";
import { loadConfig } from "../src/config.js";
import { openDatabase, type SqliteDatabase } from "../src/database.js";
import type { EmailProvider, VerificationEmail } from "../src/email-provider.js";
import { hashPassword, passwordWorkPoolStats, validateEmail } from "../src/security.js";

const ORIGIN = "https://english.test";
const CODE_SECRET = "test-email-code-secret-that-is-longer-than-32-bytes";

interface Client {
  cookie: string;
  csrf: string;
}

class CaptureEmailProvider implements EmailProvider {
  readonly enabled = true;
  readonly kind = "test" as const;
  readonly messages: VerificationEmail[] = [];
  fail = false;

  async sendVerificationCode(message: VerificationEmail): Promise<void> {
    if (this.fail) throw new Error("synthetic provider failure");
    this.messages.push({ ...message });
  }
}

function cookieFrom(headers: Record<string, string | string[] | undefined>): string {
  const raw = headers["set-cookie"];
  const first = Array.isArray(raw) ? raw[0] : raw;
  assert.ok(first);
  return first.split(";", 1)[0]!;
}

async function guest(app: FastifyInstance): Promise<Client> {
  const response = await app.inject({ method: "GET", url: "/api/auth/session" });
  assert.equal(response.statusCode, 200, response.body);
  return { cookie: cookieFrom(response.headers), csrf: response.json().csrfToken as string };
}

function writeHeaders(client: Client): Record<string, string> {
  return { cookie: client.cookie, origin: ORIGIN, "x-csrf-token": client.csrf };
}

async function fixture(options: {
  provider?: EmailProvider;
  selfRegistration?: boolean;
  dailyLimit?: number;
  registrationDailyLimit?: number;
  registrationIpDailyLimit?: number;
} = {}): Promise<{ app: FastifyInstance; db: SqliteDatabase }> {
  const db = openDatabase({ databasePath: ":memory:" });
  const app = await buildApp({
    database: db,
    seed: false,
    logger: false,
    ...(options.provider ? { emailProvider: options.provider } : {}),
    config: {
      environment: "test",
      databasePath: ":memory:",
      appOrigin: ORIGIN,
      guestTokenSecret: "test-guest-token-secret-that-is-at-least-32-bytes",
      emailCodeSecret: CODE_SECRET,
      emailSelfRegistration: options.selfRegistration ?? false,
      emailDailySendLimit: options.dailyLimit ?? 180,
      emailRegistrationDailySendLimit: options.registrationDailyLimit ?? Math.min(20, options.dailyLimit ?? 180),
      emailRegistrationIpDailyLimit: options.registrationIpDailyLimit
        ?? Math.min(10, options.registrationDailyLimit ?? Math.min(20, options.dailyLimit ?? 180))
    }
  });
  return { app, db };
}

async function closeFixture(app: FastifyInstance, db: SqliteDatabase): Promise<void> {
  await app.close();
  db.close();
}

async function insertUser(
  db: SqliteDatabase,
  username: string,
  password: string,
  email?: string
): Promise<UserRow> {
  const id = randomUUID();
  const now = Date.now();
  db.prepare(`
    INSERT INTO users(
      id, username, display_name, password_hash, role, active, must_change_password,
      created_at, updated_at, email, email_verified_at
    ) VALUES (?, ?, ?, ?, 'user', 1, 0, ?, ?, ?, ?)
  `).run(id, username, username, await hashPassword(password), now, now, email ?? null, email ? now : null);
  return db.prepare("SELECT * FROM users WHERE id = ?").get(id) as UserRow;
}

async function passwordLogin(app: FastifyInstance, username: string, password: string): Promise<Client> {
  const anonymous = await guest(app);
  const response = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    headers: writeHeaders(anonymous),
    payload: { username, password }
  });
  assert.equal(response.statusCode, 200, response.body);
  return { cookie: cookieFrom(response.headers), csrf: response.json().csrfToken as string };
}

async function requestCode(
  app: FastifyInstance,
  client: Client,
  email: string,
  purpose: VerificationEmail["purpose"]
): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: "/api/auth/email/request-code",
    headers: writeHeaders(client),
    payload: { email, purpose }
  });
  assert.equal(response.statusCode, 202, response.body);
  const payload = response.json() as {
    ok: true;
    challengeId: string;
    expiresInSeconds: number;
    retryAfterSeconds: number;
  };
  assert.equal(payload.ok, true);
  assert.match(payload.challengeId, /^[0-9a-f-]{36}$/i);
  assert.equal(payload.expiresInSeconds, 600);
  assert.equal(payload.retryAfterSeconds, 60);
  assert.ok(!response.body.includes("code"));
  return payload.challengeId;
}

function clearEmailGuards(db: SqliteDatabase): void {
  db.prepare("DELETE FROM email_auth_guards").run();
}

test("email capability defaults off and unconfigured delivery cannot create usable codes", async () => {
  const { app, db } = await fixture({ selfRegistration: true });
  try {
    const anonymous = await guest(app);
    const session = await app.inject({ method: "GET", url: "/api/auth/session", headers: { cookie: anonymous.cookie } });
    assert.deepEqual(session.json().capabilities, { emailAuthEnabled: false, selfRegistrationEnabled: false });
    const response = await app.inject({
      method: "POST",
      url: "/api/auth/email/request-code",
      headers: writeHeaders(anonymous),
      payload: { email: "person@example.com", purpose: "register" }
    });
    assert.equal(response.statusCode, 503, response.body);
    assert.equal(response.json().error.code, "EMAIL_DELIVERY_UNAVAILABLE");
    assert.equal((db.prepare("SELECT COUNT(*) AS count FROM email_verification_codes").get() as { count: number }).count, 0);
    const oversized = await app.inject({
      method: "POST",
      url: "/api/auth/email/request-code",
      headers: writeHeaders(anonymous),
      payload: { email: "person@example.com", purpose: "register", junk: "x".repeat(9_000) }
    });
    assert.equal(oversized.statusCode, 413, oversized.body);
    assert.equal(oversized.json().error.code, "BODY_TOO_LARGE");
  } finally {
    await closeFixture(app, db);
  }
});

test("registration is verified, single-use, user-only, and remains password compatible", async () => {
  const provider = new CaptureEmailProvider();
  const { app, db } = await fixture({ provider, selfRegistration: true });
  try {
    const anonymous = await guest(app);
    const session = await app.inject({ method: "GET", url: "/api/auth/session", headers: { cookie: anonymous.cookie } });
    assert.deepEqual(session.json().capabilities, { emailAuthEnabled: true, selfRegistrationEnabled: true });
    await requestCode(app, anonymous, "New.User@Example.com", "register");
    assert.equal(provider.messages.length, 1);
    const message = provider.messages[0]!;
    assert.equal(message.to, "new.user@example.com");
    const stored = db.prepare("SELECT code_hash, used_at FROM email_verification_codes").get() as {
      code_hash: string;
      used_at: number | null;
    };
    assert.equal(stored.code_hash.length, 64);
    assert.notEqual(stored.code_hash, message.code);
    assert.equal(stored.used_at, null);

    clearEmailGuards(db);
    const registrationChallenge = await requestCode(app, anonymous, "new.user@example.com", "register");
    const newestMessage = provider.messages.at(-1)!;
    const issuedRows = db.prepare(`
      SELECT COUNT(*) AS total, SUM(used_at IS NULL) AS active
      FROM email_verification_codes
      WHERE email = 'new.user@example.com' AND purpose = 'register'
    `).get() as { total: number; active: number };
    assert.deepEqual(issuedRows, { total: 2, active: 2 });

    const registered = await app.inject({
      method: "POST",
      url: "/api/auth/email/register",
      headers: writeHeaders(anonymous),
      payload: {
        email: "new.user@example.com",
        challengeId: registrationChallenge,
        code: newestMessage.code,
        username: "new.user",
        displayName: "New User",
        password: "New-User-Password!"
      }
    });
    assert.equal(registered.statusCode, 200, registered.body);
    assert.equal(registered.json().user.role, "user");
    assert.equal(registered.json().user.email, "new.user@example.com");
    assert.equal(registered.json().user.emailVerified, true);
    assert.equal(registered.json().user.mustChangePassword, false);
    assert.equal(
      (db.prepare("SELECT used_at FROM email_verification_codes WHERE id = ?").get(registrationChallenge) as { used_at: number }).used_at > 0,
      true
    );

    const replay = await app.inject({
      method: "POST",
      url: "/api/auth/email/register",
      headers: writeHeaders(anonymous),
      payload: {
        email: "new.user@example.com",
        challengeId: registrationChallenge,
        code: newestMessage.code,
        username: "another.user",
        displayName: "Another",
        password: "Another-User-Password!"
      }
    });
    assert.equal(replay.statusCode, 401, replay.body);
    assert.equal(replay.json().error.code, "INVALID_OR_EXPIRED_CODE");

    const legacyLogin = await passwordLogin(app, "new.user", "New-User-Password!");
    assert.ok(legacyLogin.cookie);

    clearEmailGuards(db);
    const before = provider.messages.length;
    await requestCode(app, await guest(app), "new.user@example.com", "register");
    assert.equal(provider.messages.length, before);
  } finally {
    await closeFixture(app, db);
  }
});

test("email login and password reset are non-enumerating and rotate all sessions", async () => {
  const provider = new CaptureEmailProvider();
  const { app, db } = await fixture({ provider });
  try {
    const user = await insertUser(db, "email.user", "Email-User-Password!", "email.user@example.com");
    const capabilities = await app.inject({ method: "GET", url: "/api/auth/session" });
    assert.deepEqual(capabilities.json().capabilities, { emailAuthEnabled: true, selfRegistrationEnabled: false });
    const registrationDisabledGuest = {
      cookie: cookieFrom(capabilities.headers),
      csrf: capabilities.json().csrfToken as string
    };
    const registrationDisabled = await app.inject({
      method: "POST",
      url: "/api/auth/email/request-code",
      headers: writeHeaders(registrationDisabledGuest),
      payload: { email: "new@example.com", purpose: "register" }
    });
    assert.equal(registrationDisabled.statusCode, 403, registrationDisabled.body);
    assert.equal(registrationDisabled.json().error.code, "SELF_REGISTRATION_DISABLED");
    const oldSession = await passwordLogin(app, user.username, "Email-User-Password!");

    const knownGuest = await guest(app);
    const loginChallenge = await requestCode(app, knownGuest, "email.user@example.com", "login");
    const loginCode = provider.messages.at(-1)!.code;
    clearEmailGuards(db);
    const messageCount = provider.messages.length;
    const unknownGuest = await guest(app);
    await requestCode(app, unknownGuest, "missing@example.com", "login");
    assert.equal(provider.messages.length, messageCount);

    const otherBrowser = await guest(app);
    const crossBrowserAttempt = await app.inject({
      method: "POST",
      url: "/api/auth/email/login",
      headers: writeHeaders(otherBrowser),
      payload: { email: "email.user@example.com", challengeId: loginChallenge, code: loginCode }
    });
    assert.equal(crossBrowserAttempt.statusCode, 401, crossBrowserAttempt.body);
    assert.equal(
      (db.prepare("SELECT attempt_count FROM email_verification_codes WHERE id = ?").get(loginChallenge) as { attempt_count: number }).attempt_count,
      0
    );

    const emailLogin = await app.inject({
      method: "POST",
      url: "/api/auth/email/login",
      headers: writeHeaders(knownGuest),
      payload: { email: "email.user@example.com", challengeId: loginChallenge, code: loginCode }
    });
    assert.equal(emailLogin.statusCode, 200, emailLogin.body);
    assert.equal(emailLogin.json().user.id, user.id);

    clearEmailGuards(db);
    const staleCodeGuest = await guest(app);
    const staleLoginChallenge = await requestCode(app, staleCodeGuest, "email.user@example.com", "login");
    const staleLoginCode = provider.messages.at(-1)!.code;
    clearEmailGuards(db);
    const resetGuest = await guest(app);
    const resetChallenge = await requestCode(app, resetGuest, "email.user@example.com", "reset_password");
    const resetCode = provider.messages.at(-1)!.code;
    const reset = await app.inject({
      method: "POST",
      url: "/api/auth/email/reset-password",
      headers: writeHeaders(resetGuest),
      payload: { email: "email.user@example.com", challengeId: resetChallenge, code: resetCode, newPassword: "Email-User-New-Password!" }
    });
    assert.equal(reset.statusCode, 200, reset.body);
    const resetClient = { cookie: cookieFrom(reset.headers), csrf: reset.json().csrfToken as string };
    assert.equal(reset.json().user.mustChangePassword, false);

    const oldAccess = await app.inject({ method: "GET", url: "/api/content", headers: { cookie: oldSession.cookie } });
    assert.equal(oldAccess.statusCode, 401, oldAccess.body);
    const resetAccess = await app.inject({ method: "GET", url: "/api/content", headers: { cookie: resetClient.cookie } });
    assert.equal(resetAccess.statusCode, 200, resetAccess.body);

    const replay = await app.inject({
      method: "POST",
      url: "/api/auth/email/reset-password",
      headers: writeHeaders(resetGuest),
      payload: { email: "email.user@example.com", challengeId: resetChallenge, code: resetCode, newPassword: "Yet-Another-Password!" }
    });
    assert.equal(replay.statusCode, 401, replay.body);
    const staleCodeLogin = await app.inject({
      method: "POST",
      url: "/api/auth/email/login",
      headers: writeHeaders(staleCodeGuest),
      payload: { email: "email.user@example.com", challengeId: staleLoginChallenge, code: staleLoginCode }
    });
    assert.equal(staleCodeLogin.statusCode, 401, staleCodeLogin.body);
    await passwordLogin(app, user.username, "Email-User-New-Password!");
  } finally {
    await closeFixture(app, db);
  }
});

test("first email binding rotates the session and codes expire or lock after five errors", async () => {
  const provider = new CaptureEmailProvider();
  const { app, db } = await fixture({ provider });
  try {
    const user = await insertUser(db, "bind.user", "Bind-User-Password!");
    const original = await passwordLogin(app, user.username, "Bind-User-Password!");
    const bindChallenge = await requestCode(app, original, "bind.user@example.com", "bind_email");
    const bindCode = provider.messages.at(-1)!.code;
    const wrongPassword = await app.inject({
      method: "POST",
      url: "/api/auth/email/bind",
      headers: writeHeaders(original),
      payload: { email: "bind.user@example.com", challengeId: bindChallenge, code: bindCode, currentPassword: "Wrong-Current-Password!" }
    });
    assert.equal(wrongPassword.statusCode, 401, wrongPassword.body);
    assert.equal(wrongPassword.json().error.code, "CURRENT_PASSWORD_INVALID");
    assert.equal(
      (db.prepare("SELECT used_at FROM email_verification_codes WHERE purpose = 'bind_email'").get() as { used_at: number | null }).used_at,
      null
    );
    const bound = await app.inject({
      method: "POST",
      url: "/api/auth/email/bind",
      headers: writeHeaders(original),
      payload: { email: "bind.user@example.com", challengeId: bindChallenge, code: bindCode, currentPassword: "Bind-User-Password!" }
    });
    assert.equal(bound.statusCode, 200, bound.body);
    assert.equal(bound.json().user.emailVerified, true);
    const boundClient = { cookie: cookieFrom(bound.headers), csrf: bound.json().csrfToken as string };
    const stale = await app.inject({ method: "GET", url: "/api/content", headers: { cookie: original.cookie } });
    assert.equal(stale.statusCode, 401, stale.body);

    clearEmailGuards(db);
    const repeat = await app.inject({
      method: "POST",
      url: "/api/auth/email/request-code",
      headers: writeHeaders(boundClient),
      payload: { email: "other@example.com", purpose: "bind_email" }
    });
    assert.equal(repeat.statusCode, 409, repeat.body);
    assert.equal(repeat.json().error.code, "EMAIL_ALREADY_BOUND");

    clearEmailGuards(db);
    const loginGuest = await guest(app);
    const lockedChallenge = await requestCode(app, loginGuest, "bind.user@example.com", "login");
    const lockedCode = provider.messages.at(-1)!.code;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const wrong = await app.inject({
        method: "POST",
        url: "/api/auth/email/login",
        headers: writeHeaders(loginGuest),
        payload: { email: "bind.user@example.com", challengeId: lockedChallenge, code: String(100000 + attempt) }
      });
      assert.equal(wrong.statusCode, 401, wrong.body);
    }
    const locked = await app.inject({
      method: "POST",
      url: "/api/auth/email/login",
      headers: writeHeaders(loginGuest),
      payload: { email: "bind.user@example.com", challengeId: lockedChallenge, code: lockedCode }
    });
    assert.equal(locked.statusCode, 401, locked.body);
    const codeState = db.prepare(`
      SELECT attempt_count, used_at FROM email_verification_codes
      WHERE purpose = 'login' ORDER BY created_at DESC LIMIT 1
    `).get() as { attempt_count: number; used_at: number | null };
    assert.equal(codeState.attempt_count, 5);
    assert.ok(codeState.used_at);

    clearEmailGuards(db);
    const expiredGuest = await guest(app);
    const expiredChallenge = await requestCode(app, expiredGuest, "bind.user@example.com", "login");
    const expiredCode = provider.messages.at(-1)!.code;
    db.prepare("UPDATE email_verification_codes SET expires_at = ? WHERE purpose = 'login' AND used_at IS NULL").run(Date.now() - 1);
    const expired = await app.inject({
      method: "POST",
      url: "/api/auth/email/login",
      headers: writeHeaders(expiredGuest),
      payload: { email: "bind.user@example.com", challengeId: expiredChallenge, code: expiredCode }
    });
    assert.equal(expired.statusCode, 401, expired.body);
  } finally {
    await closeFixture(app, db);
  }
});

test("request cooldown, daily cap, delivery failure, and test-provider production guard are enforced", async () => {
  assert.throws(() => validateEmail("<victim@example.com>"), /invalid/i);
  assert.throws(() => validateEmail("victim@example.com\u0000.example"), /invalid/i);
  assert.equal(validateEmail("User.Name+study@Example.com"), "user.name+study@example.com");
  const provider = new CaptureEmailProvider();
  const { app, db } = await fixture({ provider, dailyLimit: 1 });
  try {
    await insertUser(db, "limited.user", "Limited-User-Password!", "limited@example.com");
    const anonymous = await guest(app);
    await requestCode(app, anonymous, "cooldown-missing@example.com", "login");
    const cooldown = await app.inject({
      method: "POST",
      url: "/api/auth/email/request-code",
      headers: writeHeaders(anonymous),
      payload: { email: "cooldown-missing@example.com", purpose: "login" }
    });
    assert.equal(cooldown.statusCode, 429, cooldown.body);
    assert.equal(cooldown.json().error.code, "EMAIL_RATE_LIMITED");
    clearEmailGuards(db);
    await requestCode(app, anonymous, "limited@example.com", "login");
    clearEmailGuards(db);
    const capped = await app.inject({
      method: "POST",
      url: "/api/auth/email/request-code",
      headers: writeHeaders(await guest(app)),
      payload: { email: "unknown@example.com", purpose: "login" }
    });
    assert.equal(capped.statusCode, 429, capped.body);
    assert.equal(capped.json().error.code, "EMAIL_DAILY_LIMIT_REACHED");
  } finally {
    await closeFixture(app, db);
  }

  const failingProvider = new CaptureEmailProvider();
  failingProvider.fail = true;
  const failedFixture = await fixture({ provider: failingProvider });
  try {
    await insertUser(failedFixture.db, "failed.user", "Failed-User-Password!", "failed@example.com");
    const response = await failedFixture.app.inject({
      method: "POST",
      url: "/api/auth/email/request-code",
      headers: writeHeaders(await guest(failedFixture.app)),
      payload: { email: "failed@example.com", purpose: "login" }
    });
    assert.equal(response.statusCode, 202, response.body);
    assert.equal((failedFixture.db.prepare("SELECT COUNT(*) AS count FROM email_verification_codes").get() as { count: number }).count, 0);
  } finally {
    await closeFixture(failedFixture.app, failedFixture.db);
  }

  const previous = { nodeEnv: process.env.NODE_ENV, delivery: process.env.EMAIL_DELIVERY, outbox: process.env.EMAIL_TEST_OUTBOX_FILE };
  process.env.NODE_ENV = "production";
  process.env.EMAIL_DELIVERY = "test";
  process.env.EMAIL_TEST_OUTBOX_FILE = "test-outbox.jsonl";
  try {
    assert.throws(() => loadConfig({ databasePath: ":memory:" }), /permitted only/i);
  } finally {
    if (previous.nodeEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = previous.nodeEnv;
    if (previous.delivery === undefined) delete process.env.EMAIL_DELIVERY; else process.env.EMAIL_DELIVERY = previous.delivery;
    if (previous.outbox === undefined) delete process.env.EMAIL_TEST_OUTBOX_FILE; else process.env.EMAIL_TEST_OUTBOX_FILE = previous.outbox;
  }
});

test("registration and first-bind quotas preserve capacity for existing account recovery", async () => {
  const provider = new CaptureEmailProvider();
  const registrationFixture = await fixture({
    provider,
    selfRegistration: true,
    dailyLimit: 5,
    registrationDailyLimit: 1
  });
  try {
    await requestCode(registrationFixture.app, await guest(registrationFixture.app), "first.registration@example.com", "register");
    const registrationCapped = await registrationFixture.app.inject({
      method: "POST",
      url: "/api/auth/email/request-code",
      headers: writeHeaders(await guest(registrationFixture.app)),
      payload: { email: "second.registration@example.com", purpose: "register" }
    });
    assert.equal(registrationCapped.statusCode, 429, registrationCapped.body);
    assert.equal(registrationCapped.json().error.code, "EMAIL_DAILY_LIMIT_REACHED");

    await insertUser(
      registrationFixture.db,
      "recovery.user",
      "Recovery-User-Password!",
      "recovery.user@example.com"
    );
    await requestCode(
      registrationFixture.app,
      await guest(registrationFixture.app),
      "recovery.user@example.com",
      "reset_password"
    );
    assert.equal(provider.messages.filter((message) => message.purpose === "register").length, 1);
    assert.equal(provider.messages.filter((message) => message.purpose === "reset_password").length, 1);
  } finally {
    await closeFixture(registrationFixture.app, registrationFixture.db);
  }

  const bindProvider = new CaptureEmailProvider();
  const bindFixture = await fixture({ provider: bindProvider });
  try {
    const user = await insertUser(bindFixture.db, "bind.quota", "Bind-Quota-Password!");
    const client = await passwordLogin(bindFixture.app, user.username, "Bind-Quota-Password!");
    for (let index = 0; index < 5; index += 1) {
      await requestCode(bindFixture.app, client, `bind-quota-${index}@example.com`, "bind_email");
    }
    const blocked = await bindFixture.app.inject({
      method: "POST",
      url: "/api/auth/email/request-code",
      headers: writeHeaders(client),
      payload: { email: "bind-quota-overflow@example.com", purpose: "bind_email" }
    });
    assert.equal(blocked.statusCode, 429, blocked.body);
    assert.equal(blocked.json().error.code, "EMAIL_RATE_LIMITED");
    assert.equal(bindProvider.messages.length, 5);
  } finally {
    await closeFixture(bindFixture.app, bindFixture.db);
  }
});

test("independent challenges cannot invalidate or consume another browser's code", async () => {
  const provider = new CaptureEmailProvider();
  const { app, db } = await fixture({ provider });
  try {
    await insertUser(db, "replacement.user", "Replacement-User-Password!", "replacement.user@example.com");
    const firstGuest = await guest(app);
    const firstChallenge = await requestCode(app, firstGuest, "replacement.user@example.com", "reset_password");
    const firstCode = provider.messages.at(-1)!.code;

    clearEmailGuards(db);
    const resetting = app.inject({
      method: "POST",
      url: "/api/auth/email/reset-password",
      headers: writeHeaders(firstGuest),
      payload: {
        email: "replacement.user@example.com",
        challengeId: firstChallenge,
        code: firstCode,
        newPassword: "Replacement-User-New-Password!"
      }
    });
    await new Promise((resolve) => setTimeout(resolve, 20));

    clearEmailGuards(db);
    await requestCode(app, await guest(app), "replacement.user@example.com", "reset_password");

    const firstReset = await resetting;
    assert.equal(firstReset.statusCode, 200, firstReset.body);
    const latest = db.prepare(`
      SELECT attempt_count, used_at FROM email_verification_codes
      WHERE email = ? AND purpose = 'reset_password'
      ORDER BY created_at DESC, rowid DESC LIMIT 1
    `).get("replacement.user@example.com") as { attempt_count: number; used_at: number | null };
    assert.deepEqual(latest, { attempt_count: 0, used_at: null });
  } finally {
    await closeFixture(app, db);
  }
});

test("an invalid email code is rejected before the Argon2 work queue", async () => {
  const provider = new CaptureEmailProvider();
  const { app, db } = await fixture({ provider });
  let blockers: Array<Promise<string>> = [];
  try {
    await insertUser(db, "queue.user", "Queue-User-Password!", "queue.user@example.com");
    const client = await guest(app);
    const challengeId = await requestCode(app, client, "queue.user@example.com", "reset_password");
    const actualCode = provider.messages.at(-1)!.code;
    const invalidCode = actualCode === "999999" ? "000000" : "999999";
    clearEmailGuards(db);

    blockers = Array.from({ length: 36 }, (_, index) => hashPassword(`Queue-Saturation-Password-${index}!`));
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(passwordWorkPoolStats(), { active: 4, queued: 32 });

    const invalid = await app.inject({
      method: "POST",
      url: "/api/auth/email/reset-password",
      headers: writeHeaders(client),
      payload: {
        email: "queue.user@example.com",
        challengeId,
        code: invalidCode,
        newPassword: "Queue-User-New-Password!"
      }
    });
    assert.equal(invalid.statusCode, 401, invalid.body);
    assert.equal(invalid.json().error.code, "INVALID_OR_EXPIRED_CODE");
  } finally {
    await Promise.all(blockers);
    await closeFixture(app, db);
  }
});

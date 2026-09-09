import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { openDatabase } from "../src/database.js";
import { hashPassword } from "../src/security.js";
import type { EmailProvider, VerificationEmail } from "../src/email-provider.js";

const ORIGIN = "https://regression.test";
const SECRET = "guest-regression-secret-longer-than-thirty-two-bytes";
type Client = { cookie: string; csrf: string };
function headers(client: Client) {
  return { cookie: client.cookie, origin: ORIGIN, "x-csrf-token": client.csrf };
}
function responseClient(response: { headers: Record<string, unknown>; json(): any }): Client {
  const cookies = response.headers["set-cookie"];
  const cookie = (Array.isArray(cookies) ? cookies[0] : cookies) as string;
  return { cookie: cookie.split(";")[0]!, csrf: response.json().csrfToken };
}
async function guest(app: FastifyInstance, previous?: Client) {
  return responseClient(await app.inject({ url: "/api/auth/session", headers: previous ? headers(previous) : {} }));
}

test("refreshing guest session in another tab preserves existing email challenges", async () => {
  const messages: VerificationEmail[] = [];
  const provider: EmailProvider = {
    kind: "test", enabled: true,
    async sendVerificationCode(message) { messages.push(message); }
  };
  const db = openDatabase({ databasePath: ":memory:" });
  const app = await buildApp({ database: db, seed: false, logger: false, emailProvider: provider,
    config: { environment: "test", appOrigin: ORIGIN, guestTokenSecret: SECRET, emailCodeSecret: SECRET }
  });
  try {
    const now = Date.now();
    db.prepare(`INSERT INTO users(id,username,display_name,password_hash,role,active,must_change_password,
      created_at,updated_at,email,email_verified_at) VALUES (?,'email.user','User',?,'user',1,0,?,?,?,?)`)
      .run(randomUUID(), await hashPassword("Regression-Password-123!"), now, now, "user@example.com", now);
    const original = await guest(app);
    const sent = await app.inject({ method: "POST", url: "/api/auth/email/request-code", headers: headers(original),
      payload: { email: "user@example.com", purpose: "login" } });
    assert.equal(sent.statusCode, 202);
    const challengeId = sent.json().challengeId;
    assert.equal(messages.length, 1);
    const refreshed = await guest(app, original);
    const refreshedAgain = await guest(app, refreshed);
    assert.equal(refreshedAgain.csrf, original.csrf);
    const stranger = await guest(app);
    const missing = await app.inject({ method: "POST", url: "/api/auth/email/request-code", headers: headers(stranger),
      payload: { email: "missing@example.com", purpose: "login" } });
    assert.equal(missing.statusCode, 202);
    const payload = { email: "user@example.com", challengeId, code: messages[0]!.code };
    for (let index = 0; index < 25; index++) {
      const denied = await app.inject({ method: "POST", url: "/api/auth/email/login", headers: headers(stranger),
        remoteAddress: `198.51.100.${index + 1}`, payload });
      assert.equal(denied.statusCode, index < 20 ? 401 : 429);
      const unknown = await app.inject({ method: "POST", url: "/api/auth/email/login", headers: headers(stranger),
        remoteAddress: `198.51.100.${index + 1}`,
        payload: { email: "missing@example.com", challengeId: missing.json().challengeId, code: "000000" } });
      assert.equal(unknown.statusCode, denied.statusCode, "real and decoy challenges must have equivalent throttling");
    }
    const login = await app.inject({ method: "POST", url: "/api/auth/email/login", headers: headers(refreshedAgain), payload });
    assert.equal(login.statusCode, 200, login.body);
    assert.equal(login.json().user.username, "email.user");
  } finally { await app.close(); db.close(); }
});

test("password change rejects repeated guesses before further password work, including after restart", async () => {
  const db = openDatabase({ databasePath: ":memory:" });
  const options = { database: db, seed: false, logger: false,
    config: { appOrigin: ORIGIN, guestTokenSecret: SECRET } };
  let app = await buildApp(options);
  try {
    const now = Date.now();
    db.prepare(`INSERT INTO users(id,username,display_name,password_hash,role,active,must_change_password,
      created_at,updated_at) VALUES (?,'test.user','User',?,'user',1,0,?,?)`)
      .run(randomUUID(), await hashPassword("Current-Password-123!"), now, now);
    const anon = await guest(app);
    const signed = await app.inject({ method: "POST", url: "/api/auth/login", headers: headers(anon),
      payload: { username: "test.user", password: "Current-Password-123!" } });
    const client = responseClient(signed);
    for (let i = 0; i < 10; i++) {
      const failed = await app.inject({ method: "POST", url: "/api/auth/change-password", headers: headers(client),
        payload: { currentPassword: "Incorrect-Password!", newPassword: "New-Password-123!" } });
      assert.equal(failed.statusCode, 401, failed.body);
    }
    await app.close();
    app = await buildApp(options);
    const limited = await app.inject({ method: "POST", url: "/api/auth/change-password", headers: headers(client),
      payload: { currentPassword: "Incorrect-Password!", newPassword: "New-Password-123!" } });
    assert.equal(limited.statusCode, 429, limited.body);
    assert.ok(limited.json().error.details.retryAfterSeconds > 0);
  } finally { await app.close(); db.close(); }
});

test("in-memory database configuration does not create a file named :memory:", () => {
  assert.equal(loadConfig({ databasePath: ":memory:" }).databasePath, ":memory:");
});

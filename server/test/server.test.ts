import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import test from "node:test";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { openDatabase, type SqliteDatabase } from "../src/database.js";
import { hashPassword } from "../src/security.js";

const ORIGIN = "https://english.test";
const SOURCE = resolve(import.meta.dirname, "../..");

interface Client {
  cookie: string;
  csrf: string;
}

function cookieFrom(headers: Record<string, string | string[] | undefined>): string {
  const raw = headers["set-cookie"];
  const first = Array.isArray(raw) ? raw[0] : raw;
  assert.ok(first);
  return first.split(";", 1)[0]!;
}

async function guest(app: FastifyInstance): Promise<Client> {
  const response = await app.inject({ method: "GET", url: "/api/auth/session" });
  assert.equal(response.statusCode, 200);
  return { cookie: cookieFrom(response.headers), csrf: response.json().csrfToken as string };
}

async function login(app: FastifyInstance, username: string, password: string): Promise<Client> {
  const client = await guest(app);
  const response = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    headers: { cookie: client.cookie, origin: ORIGIN, "x-csrf-token": client.csrf },
    payload: { username, password }
  });
  assert.equal(response.statusCode, 200, response.body);
  return { cookie: cookieFrom(response.headers), csrf: response.json().csrfToken as string };
}

async function changePassword(app: FastifyInstance, client: Client, currentPassword: string, newPassword: string): Promise<Client> {
  const response = await app.inject({
    method: "POST",
    url: "/api/auth/change-password",
    headers: { cookie: client.cookie, origin: ORIGIN, "x-csrf-token": client.csrf },
    payload: { currentPassword, newPassword }
  });
  assert.equal(response.statusCode, 200, response.body);
  return { cookie: cookieFrom(response.headers), csrf: response.json().csrfToken as string };
}

async function insertUser(
  db: SqliteDatabase,
  username: string,
  password: string,
  role: "user" | "admin",
  mustChange = true
): Promise<string> {
  const id = randomUUID();
  const now = Date.now();
  db.prepare(`
    INSERT INTO users(id, username, display_name, password_hash, role, active, must_change_password, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)
  `).run(id, username, username, await hashPassword(password), role, mustChange ? 1 : 0, now, now);
  return id;
}

test("seed, auth, CSRF, RBAC, user isolation and final-admin protection", async () => {
  const db = openDatabase({ databasePath: ":memory:" });
  const app = await buildApp({
    database: db,
    logger: false,
    config: { databasePath: ":memory:", appOrigin: ORIGIN, contentSourceDir: SOURCE }
  });
  try {
    const counts = db.prepare(`
      SELECT SUM(kind = 'word') AS words, SUM(kind = 'sentence') AS sentences FROM items
    `).get() as { words: number; sentences: number };
    assert.deepEqual(counts, { words: 850, sentences: 168 });

    const adminId = await insertUser(db, "admin", "Admin-Temporary-123!", "admin");
    await insertUser(db, "student.a", "Student-Temporary-123!", "user");
    await insertUser(db, "student.b", "Student-Temporary-456!", "user");

    const noCsrf = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "admin", password: "x" } });
    assert.equal(noCsrf.statusCode, 403);
    assert.equal(noCsrf.json().error.code, "ORIGIN_INVALID");

    let admin = await login(app, "admin", "Admin-Temporary-123!");
    const blockedBeforeChange = await app.inject({ method: "GET", url: "/api/content", headers: { cookie: admin.cookie } });
    assert.equal(blockedBeforeChange.statusCode, 403);
    assert.equal(blockedBeforeChange.json().error.code, "MUST_CHANGE_PASSWORD");
    admin = await changePassword(app, admin, "Admin-Temporary-123!", "Admin-New-Password-123!");

    const contentResponse = await app.inject({ method: "GET", url: "/api/content", headers: { cookie: admin.cookie } });
    assert.equal(contentResponse.statusCode, 200, contentResponse.body);
    const content = contentResponse.json() as { version: string; items: Array<{ id: string; english: string; revision: number }> };
    assert.equal(content.items.length, 1018);
    assert.ok(content.version);

    const disableLastAdmin = await app.inject({
      method: "PATCH",
      url: `/api/admin/users/${adminId}`,
      headers: { cookie: admin.cookie, origin: ORIGIN, "x-csrf-token": admin.csrf },
      payload: { active: false }
    });
    assert.equal(disableLastAdmin.statusCode, 409, disableLastAdmin.body);
    assert.equal(disableLastAdmin.json().error.code, "LAST_ADMIN");

    const resetSelf = await app.inject({
      method: "POST",
      url: `/api/admin/users/${adminId}/reset-password`,
      headers: { cookie: admin.cookie, origin: ORIGIN, "x-csrf-token": admin.csrf },
      payload: {}
    });
    assert.equal(resetSelf.statusCode, 409, resetSelf.body);
    assert.equal(resetSelf.json().error.code, "SELF_PASSWORD_RESET_FORBIDDEN");

    let userA = await login(app, "student.a", "Student-Temporary-123!");
    userA = await changePassword(app, userA, "Student-Temporary-123!", "Student-A-New-Password!");
    let userB = await login(app, "student.b", "Student-Temporary-456!");
    userB = await changePassword(app, userB, "Student-Temporary-456!", "Student-B-New-Password!");

    const forbidden = await app.inject({ method: "GET", url: "/api/admin/users", headers: { cookie: userA.cookie } });
    assert.equal(forbidden.statusCode, 403);
    assert.equal(forbidden.json().error.code, "ADMIN_REQUIRED");

    async function wrongAttempt(client: Client, itemIndex: number) {
      const created = await app.inject({
        method: "POST",
        url: "/api/practice/sessions",
        headers: { cookie: client.cookie, origin: ORIGIN, "x-csrf-token": client.csrf },
        payload: { mode: "sequential" }
      });
      assert.equal(created.statusCode, 200, created.body);
      const sessionId = created.json().session.id as string;
      const clientAttemptId = randomUUID();
      const payload = {
        clientAttemptId,
        itemId: content.items[itemIndex]!.id,
        itemRevision: content.items[itemIndex]!.revision,
        answer: "definitely wrong",
        durationMs: 1200
      };
      const first = await app.inject({
        method: "POST",
        url: `/api/practice/sessions/${sessionId}/attempts`,
        headers: { cookie: client.cookie, origin: ORIGIN, "x-csrf-token": client.csrf },
        payload
      });
      assert.equal(first.statusCode, 200, first.body);
      assert.equal(first.json().attempt.correct, false);
      const retry = await app.inject({
        method: "POST",
        url: `/api/practice/sessions/${sessionId}/attempts`,
        headers: { cookie: client.cookie, origin: ORIGIN, "x-csrf-token": client.csrf },
        payload
      });
      assert.equal(retry.statusCode, 200, retry.body);
      assert.equal(retry.json().summary.done, 1);
    }

    await wrongAttempt(userA, 0);
    await wrongAttempt(userB, 1);
    const mistakesA = await app.inject({ method: "GET", url: "/api/me/mistakes", headers: { cookie: userA.cookie } });
    const mistakesB = await app.inject({ method: "GET", url: "/api/me/mistakes", headers: { cookie: userB.cookie } });
    assert.equal(mistakesA.json().items.length, 1);
    assert.equal(mistakesB.json().items.length, 1);
    assert.equal(mistakesA.json().items[0].item.id, content.items[0]!.id);
    assert.equal(mistakesB.json().items[0].item.id, content.items[1]!.id);

    const firstImport = await app.inject({
      method: "POST",
      url: "/api/me/mistakes/import",
      headers: { cookie: userA.cookie, origin: ORIGIN, "x-csrf-token": userA.csrf },
      payload: { answers: [content.items[2]!.english] }
    });
    assert.equal(firstImport.statusCode, 200, firstImport.body);
    assert.equal(firstImport.json().alreadyImported, false);
    const repeatedImport = await app.inject({
      method: "POST",
      url: "/api/me/mistakes/import",
      headers: { cookie: userA.cookie, origin: ORIGIN, "x-csrf-token": userA.csrf },
      payload: { answers: [content.items[3]!.english] }
    });
    assert.equal(repeatedImport.json().alreadyImported, true);
  } finally {
    await app.close();
    db.close();
  }
});

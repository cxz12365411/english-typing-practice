import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import test from "node:test";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { cleanupExpiredSecurityRows, createSession, type UserRow } from "../src/auth.js";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { migrateAndSeed, migrateDatabase, openDatabase, type SqliteDatabase } from "../src/database.js";
import { BoundedWorkPool, hashPassword, tokenHash } from "../src/security.js";

const ORIGIN = "https://english.test";
const SOURCE = resolve(import.meta.dirname, "../..");

interface Client {
  cookie: string;
  csrf: string;
}

interface ContentItem {
  id: string;
  categoryId: string;
  english: string;
  revision: number;
}

function cookieFrom(headers: Record<string, string | string[] | undefined>): string {
  const raw = headers["set-cookie"];
  const first = Array.isArray(raw) ? raw[0] : raw;
  assert.ok(first);
  return first.split(";", 1)[0]!;
}

async function fixture(): Promise<{ app: FastifyInstance; db: SqliteDatabase }> {
  const db = openDatabase({ databasePath: ":memory:" });
  const app = await buildApp({
    database: db,
    logger: false,
    config: {
      databasePath: ":memory:",
      appOrigin: ORIGIN,
      contentSourceDir: SOURCE,
      guestTokenSecret: "test-guest-token-secret-at-least-32-bytes"
    }
  });
  return { app, db };
}

async function closeFixture(app: FastifyInstance, db: SqliteDatabase): Promise<void> {
  await app.close();
  db.close();
}

async function guest(app: FastifyInstance, cookie?: string): Promise<Client> {
  const response = await app.inject({ method: "GET", url: "/api/auth/session", headers: cookie ? { cookie } : undefined });
  assert.equal(response.statusCode, 200, response.body);
  return { cookie: cookieFrom(response.headers), csrf: response.json().csrfToken as string };
}

async function login(app: FastifyInstance, username: string, password: string): Promise<Client> {
  const anonymous = await guest(app);
  const response = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    headers: { cookie: anonymous.cookie, origin: ORIGIN, "x-csrf-token": anonymous.csrf },
    payload: { username, password }
  });
  assert.equal(response.statusCode, 200, response.body);
  return { cookie: cookieFrom(response.headers), csrf: response.json().csrfToken as string };
}

function writeHeaders(client: Client): Record<string, string> {
  return { cookie: client.cookie, origin: ORIGIN, "x-csrf-token": client.csrf };
}

async function insertUser(
  db: SqliteDatabase,
  username: string,
  password: string,
  role: "user" | "admin" = "user",
  mustChange = false
): Promise<UserRow> {
  const id = randomUUID();
  const now = Date.now();
  db.prepare(`
    INSERT INTO users(id, username, display_name, password_hash, role, active, must_change_password, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)
  `).run(id, username, username, await hashPassword(password), role, mustChange ? 1 : 0, now, now);
  return db.prepare("SELECT * FROM users WHERE id = ?").get(id) as UserRow;
}

async function getContent(app: FastifyInstance, client: Client): Promise<{
  version: string;
  categories: Array<{ id: string; name: string }>;
  items: ContentItem[];
}> {
  const response = await app.inject({ method: "GET", url: "/api/content", headers: { cookie: client.cookie } });
  assert.equal(response.statusCode, 200, response.body);
  return response.json();
}

async function createPracticeSession(app: FastifyInstance, client: Client): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: "/api/practice/sessions",
    headers: writeHeaders(client),
    payload: { mode: "sequential" }
  });
  assert.equal(response.statusCode, 200, response.body);
  return response.json().session.id as string;
}

test("migration history is checksummed, rejects future schemas, and the initial seed is one-shot", () => {
  const db = openDatabase({ databasePath: ":memory:" });
  try {
    const first = migrateAndSeed(db, SOURCE);
    assert.equal(first.itemsInserted, 1018);
    const second = migrateAndSeed(db, "Z:\\path-that-does-not-exist");
    assert.equal(second.itemsInserted, 0);
    assert.equal(second.words, 850);
    assert.equal(second.sentences, 168);
    db.prepare("UPDATE schema_migrations SET checksum = 'tampered' WHERE version = 2").run();
    assert.throws(() => migrateDatabase(db), /checksum mismatch/i);
  } finally {
    db.close();
  }

  const future = openDatabase({ databasePath: ":memory:" });
  try {
    migrateDatabase(future);
    future.prepare("INSERT INTO schema_migrations(version, checksum, applied_at) VALUES (999, 'future', ?)").run(Date.now());
    assert.throws(() => migrateDatabase(future), /newer than or unknown/i);
  } finally {
    future.close();
  }
});

test("guest CSRF is stateless, malformed JSON stays 4xx, and proxy trust accepts one loopback hop only", async () => {
  const { app, db } = await fixture();
  try {
    const first = await guest(app);
    await guest(app, first.cookie);
    const sessions = db.prepare("SELECT COUNT(*) AS count FROM sessions").get() as { count: number };
    assert.equal(sessions.count, 0);

    const malformed = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      headers: {
        cookie: first.cookie,
        origin: ORIGIN,
        "x-csrf-token": first.csrf,
        "content-type": "application/json"
      },
      payload: '{"username":'
    });
    assert.equal(malformed.statusCode, 400, malformed.body);
    assert.equal(malformed.json().error.code, "INVALID_JSON");

    const oversized = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      headers: writeHeaders(first),
      payload: { username: "missing.user", password: "invalid", junk: "x".repeat(9_000) }
    });
    assert.equal(oversized.statusCode, 413, oversized.body);
    assert.equal(oversized.json().error.code, "BODY_TOO_LARGE");

    const oversizedUnauthenticatedWrite = await app.inject({
      method: "POST",
      url: "/api/practice/sessions",
      headers: writeHeaders(first),
      payload: { mode: "sequential", junk: "x".repeat(70_000) }
    });
    assert.equal(oversizedUnauthenticatedWrite.statusCode, 413, oversizedUnauthenticatedWrite.body);
    assert.equal(oversizedUnauthenticatedWrite.json().error.code, "BODY_TOO_LARGE");

    const proxyGuest = await guest(app);
    const failed = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      headers: {
        cookie: proxyGuest.cookie,
        origin: ORIGIN,
        "x-csrf-token": proxyGuest.csrf,
        "x-forwarded-for": "198.51.100.77, 203.0.113.9"
      },
      payload: { username: "missing.user", password: "not-the-password" }
    });
    assert.equal(failed.statusCode, 401, failed.body);
    const ipGuard = db.prepare("SELECT guard_key FROM login_guards WHERE scope = 'ip'").get() as { guard_key: string };
    assert.equal(ipGuard.guard_key, "203.0.113.9");

    const previous = process.env.TRUST_PROXY;
    process.env.TRUST_PROXY = "true";
    try {
      assert.throws(() => loadConfig({ databasePath: ":memory:" }), /TRUST_PROXY/);
    } finally {
      if (previous === undefined) delete process.env.TRUST_PROXY;
      else process.env.TRUST_PROXY = previous;
    }
  } finally {
    await closeFixture(app, db);
  }
});

test("password work is globally bounded with a finite queue", async () => {
  const pool = new BoundedWorkPool(2, 1);
  let running = 0;
  let maximum = 0;
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const work = () => pool.run(async () => {
    running += 1;
    maximum = Math.max(maximum, running);
    await blocked;
    running -= 1;
  });
  const first = work();
  const second = work();
  const third = work();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(pool.stats, { active: 2, queued: 1 });
  await assert.rejects(work(), /queue is full/i);
  release();
  await Promise.all([first, second, third]);
  assert.equal(maximum, 2);
  assert.deepEqual(pool.stats, { active: 0, queued: 0 });
});

test("login has hard IP+account reservations, account-only risk does not lock, reset clears account guards", async () => {
  const { app, db } = await fixture();
  try {
    await insertUser(db, "admin.one", "Admin-One-Password!", "admin");
    const target = await insertUser(db, "target.user", "Target-User-Password!");
    db.prepare("UPDATE users SET email = ?, email_verified_at = ? WHERE id = ?").run(
      "target.user@example.com",
      Date.now(),
      target.id
    );
    const account = "target.user";
    const ip = "127.0.0.1";
    const now = Date.now();
    db.prepare(`
      INSERT INTO login_guards(
        scope, guard_key, account_key, ip_address, window_started_at,
        reservation_count, failure_count, blocked_until, updated_at
      ) VALUES ('ip_account', ?, ?, ?, ?, 10, 10, NULL, ?)
    `).run(tokenHash(`${account}\n${ip}`), account, ip, now, now);
    const blockedGuest = await guest(app);
    const blocked = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      headers: writeHeaders(blockedGuest),
      payload: { username: account, password: "Target-User-Password!" }
    });
    assert.equal(blocked.statusCode, 429, blocked.body);

    db.prepare("DELETE FROM login_guards").run();
    db.prepare(`
      INSERT INTO login_guards(
        scope, guard_key, account_key, window_started_at,
        reservation_count, failure_count, blocked_until, updated_at
      ) VALUES ('account_risk', ?, ?, ?, 0, 100, NULL, ?)
    `).run(account, account, now, now);
    const riskLogin = await login(app, account, "Target-User-Password!");
    assert.ok(riskLogin.cookie);

    const admin = await login(app, "admin.one", "Admin-One-Password!");
    db.prepare(`
      INSERT INTO login_guards(
        scope, guard_key, account_key, ip_address, window_started_at,
        reservation_count, failure_count, blocked_until, updated_at
      ) VALUES ('ip_account', ?, ?, '192.0.2.4', ?, 10, 10, ?, ?)
    `).run(tokenHash(`${account}\n192.0.2.4`), account, now, now + 60_000, now);
    const reset = await app.inject({
      method: "POST",
      url: `/api/admin/users/${target.id}/reset-password`,
      headers: writeHeaders(admin),
      payload: {}
    });
    assert.equal(reset.statusCode, 200, reset.body);
    assert.equal((db.prepare("SELECT COUNT(*) AS count FROM login_guards WHERE account_key = ?").get(account) as { count: number }).count, 0);
    const resetUser = db.prepare("SELECT email, email_verified_at FROM users WHERE id = ?").get(target.id) as {
      email: string | null;
      email_verified_at: number | null;
    };
    assert.deepEqual(resetUser, { email: null, email_verified_at: null });
    assert.equal(reset.json().user.email, undefined);

    const parallelGuests = await Promise.all(Array.from({ length: 11 }, () => guest(app)));
    const parallel = await Promise.all(parallelGuests.map((candidate) => app.inject({
      method: "POST",
      url: "/api/auth/login",
      headers: writeHeaders(candidate),
      payload: { username: "parallel.missing", password: "invalid-password" }
    })));
    assert.equal(parallel.filter((response) => response.statusCode === 401).length, 10);
    assert.equal(parallel.filter((response) => response.statusCode === 429).length, 1);
    const pair = db.prepare("SELECT reservation_count FROM login_guards WHERE scope = 'ip_account' AND account_key = ?").get(
      "parallel.missing"
    ) as { reservation_count: number };
    assert.equal(pair.reservation_count, 10);
  } finally {
    await closeFixture(app, db);
  }
});

test("slow password operations reject stale actor and stale password state", async () => {
  const { app, db } = await fixture();
  try {
    const adminRow = await insertUser(db, "race.admin", "Race-Admin-Password!", "admin");
    const target = await insertUser(db, "race.target", "Race-Target-Password!");
    const user = await insertUser(db, "race.user", "Race-User-Password!");
    const admin = await login(app, adminRow.username, "Race-Admin-Password!");
    const userClient = await login(app, user.username, "Race-User-Password!");
    const replacement = await hashPassword("Externally-Changed-Password!");
    const targetReplacement = await hashPassword("Externally-Reset-Target!");

    const changing = app.inject({
      method: "POST",
      url: "/api/auth/change-password",
      headers: writeHeaders(userClient),
      payload: { currentPassword: "Race-User-Password!", newPassword: "Race-User-New-Password!" }
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    db.prepare("UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?").run(replacement, Date.now(), user.id);
    const changed = await changing;
    assert.equal(changed.statusCode, 409, changed.body);
    assert.equal(changed.json().error.code, "AUTH_STATE_CHANGED");

    const staleTargetReset = app.inject({
      method: "POST",
      url: `/api/admin/users/${target.id}/reset-password`,
      headers: writeHeaders(admin),
      payload: {}
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    db.prepare("UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?").run(targetReplacement, Date.now(), target.id);
    const staleTarget = await staleTargetReset;
    assert.equal(staleTarget.statusCode, 409, staleTarget.body);
    assert.equal(staleTarget.json().error.code, "TARGET_STATE_CHANGED");

    const resetting = app.inject({
      method: "POST",
      url: `/api/admin/users/${target.id}/reset-password`,
      headers: writeHeaders(admin),
      payload: {}
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    db.prepare("UPDATE users SET role = 'user', auth_version = auth_version + 1, updated_at = ? WHERE id = ?").run(
      Date.now(),
      adminRow.id
    );
    const reset = await resetting;
    assert.equal(reset.statusCode, 409, reset.body);
    assert.equal(reset.json().error.code, "AUTH_STATE_CHANGED");

    db.prepare("UPDATE users SET auth_version = auth_version + 1 WHERE id = ?").run(user.id);
    const invalidated = await app.inject({ method: "GET", url: "/api/content", headers: { cookie: userClient.cookie } });
    assert.equal(invalidated.statusCode, 401, invalidated.body);
  } finally {
    await closeFixture(app, db);
  }
});

test("logout atomically finishes active practice and repeated login-refresh cycles never accumulate active sessions", async () => {
  const { app, db } = await fixture();
  try {
    const user = await insertUser(db, "logout.user", "Logout-User-Password!");
    for (let index = 0; index < 11; index += 1) {
      const client = await login(app, user.username, "Logout-User-Password!");
      const sessionId = await createPracticeSession(app, client);
      const logout = await app.inject({
        method: "POST",
        url: "/api/auth/logout",
        headers: writeHeaders(client),
        payload: {}
      });
      assert.equal(logout.statusCode, 200, logout.body);
      const row = db.prepare("SELECT finished_at, duration_ms FROM practice_sessions WHERE id = ?").get(sessionId) as {
        finished_at: number | null;
        duration_ms: number;
      };
      assert.ok(row.finished_at);
      assert.ok(row.duration_ms >= 0);
      const active = db.prepare(`
        SELECT COUNT(*) AS count FROM practice_sessions WHERE user_id = ? AND finished_at IS NULL
      `).get(user.id) as { count: number };
      assert.equal(active.count, 0);
    }
    const finalClient = await login(app, user.username, "Logout-User-Password!");
    for (let index = 0; index < 11; index += 1) await createPracticeSession(app, finalClient);
    const counts = db.prepare(`
      SELECT COUNT(*) AS total, SUM(CASE WHEN finished_at IS NULL THEN 1 ELSE 0 END) AS active
      FROM practice_sessions WHERE user_id = ?
    `).get(user.id) as { total: number; active: number };
    assert.equal(counts.total, 22);
    assert.equal(counts.active, 1);
    const now = Date.now();
    const insertFinished = db.prepare(`
      INSERT INTO practice_sessions(id, user_id, mode, started_at, finished_at)
      VALUES (?, ?, 'sequential', ?, ?)
    `);
    db.transaction(() => {
      for (let index = counts.total; index < 60; index += 1) {
        insertFinished.run(randomUUID(), user.id, now, now);
      }
    })();
    const rateLimited = await app.inject({
      method: "POST",
      url: "/api/practice/sessions",
      headers: writeHeaders(finalClient),
      payload: { mode: "sequential" }
    });
    assert.equal(rateLimited.statusCode, 429, rateLimited.body);
    assert.equal(rateLimited.json().error.code, "PRACTICE_SESSION_RATE_LIMITED");
  } finally {
    await closeFixture(app, db);
  }
});

test("attempts enforce revision, exact idempotency after finish, ordering, rate, retention, and active-session limits", async () => {
  const { app, db } = await fixture();
  try {
    const user = await insertUser(db, "practice.user", "Practice-User-Password!");
    const client = await login(app, user.username, "Practice-User-Password!");
    const content = await getContent(app, client);
    const item = content.items[0]!;
    const sessionId = await createPracticeSession(app, client);
    const occurredAt = new Date().toISOString();
    const payload = {
      clientAttemptId: randomUUID(),
      itemId: item.id,
      itemRevision: item.revision,
      answer: "wrong answer",
      durationMs: 500,
      occurredAt
    };
    const first = await app.inject({
      method: "POST",
      url: `/api/practice/sessions/${sessionId}/attempts`,
      headers: writeHeaders(client),
      payload
    });
    assert.equal(first.statusCode, 200, first.body);
    assert.equal(first.json().attempt.itemRevision, item.revision);
    const finish = await app.inject({
      method: "POST",
      url: `/api/practice/sessions/${sessionId}/finish`,
      headers: writeHeaders(client),
      payload: {}
    });
    assert.equal(finish.statusCode, 200, finish.body);
    const replay = await app.inject({
      method: "POST",
      url: `/api/practice/sessions/${sessionId}/attempts`,
      headers: writeHeaders(client),
      payload
    });
    assert.equal(replay.statusCode, 200, replay.body);
    assert.equal(replay.json().summary.done, 1);
    const mismatch = await app.inject({
      method: "POST",
      url: `/api/practice/sessions/${sessionId}/attempts`,
      headers: writeHeaders(client),
      payload: { ...payload, durationMs: 501 }
    });
    assert.equal(mismatch.statusCode, 409, mismatch.body);
    assert.equal(mismatch.json().error.code, "ATTEMPT_REPLAY_MISMATCH");

    const revisionSession = await createPracticeSession(app, client);
    const stale = await app.inject({
      method: "POST",
      url: `/api/practice/sessions/${revisionSession}/attempts`,
      headers: writeHeaders(client),
      payload: {
        clientAttemptId: randomUUID(), itemId: item.id, itemRevision: item.revision + 1, answer: item.english, durationMs: 1
      }
    });
    assert.equal(stale.statusCode, 409, stale.body);
    assert.equal(stale.json().error.code, "CONTENT_CHANGED");

    const newest = Date.now();
    const newerWrong = await app.inject({
      method: "POST",
      url: `/api/practice/sessions/${revisionSession}/attempts`,
      headers: writeHeaders(client),
      payload: {
        clientAttemptId: randomUUID(), itemId: item.id, itemRevision: item.revision,
        answer: "wrong", durationMs: 1, occurredAt: new Date(newest).toISOString()
      }
    });
    assert.equal(newerWrong.statusCode, 200, newerWrong.body);
    const olderCorrect = await app.inject({
      method: "POST",
      url: `/api/practice/sessions/${revisionSession}/attempts`,
      headers: writeHeaders(client),
      payload: {
        clientAttemptId: randomUUID(), itemId: item.id, itemRevision: item.revision,
        answer: item.english, durationMs: 1, occurredAt: new Date(newest - 60_000).toISOString()
      }
    });
    assert.equal(olderCorrect.statusCode, 200, olderCorrect.body);
    const progress = db.prepare("SELECT is_mistake, last_attempt_at FROM progress WHERE user_id = ? AND item_id = ?").get(
      user.id,
      item.id
    ) as { is_mistake: number; last_attempt_at: number };
    assert.equal(progress.is_mistake, 1);
    assert.equal(progress.last_attempt_at, newest);

    const concurrentSession = await createPracticeSession(app, client);
    const concurrentPayload = {
      clientAttemptId: randomUUID(), itemId: item.id, itemRevision: item.revision, answer: item.english, durationMs: 2
    };
    const concurrent = await Promise.all([
      app.inject({ method: "POST", url: `/api/practice/sessions/${concurrentSession}/attempts`, headers: writeHeaders(client), payload: concurrentPayload }),
      app.inject({ method: "POST", url: `/api/practice/sessions/${concurrentSession}/attempts`, headers: writeHeaders(client), payload: concurrentPayload })
    ]);
    assert.deepEqual(concurrent.map((response) => response.statusCode), [200, 200]);
    assert.equal((db.prepare("SELECT total_attempts FROM practice_sessions WHERE id = ?").get(concurrentSession) as { total_attempts: number }).total_attempts, 1);

    const orderedSession = await createPracticeSession(app, client);
    const chronologicalBase = Date.now() - 10_000;
    const chronologicalAttempts = [
      { key: "t3-arrived-first", at: chronologicalBase + 3_000, answer: item.english },
      { key: "t1-arrived-second", at: chronologicalBase + 1_000, answer: "wrong" },
      { key: "t2-arrived-third", at: chronologicalBase + 2_000, answer: item.english }
    ];
    for (const entry of chronologicalAttempts) {
      const response = await app.inject({
        method: "POST",
        url: `/api/practice/sessions/${orderedSession}/attempts`,
        headers: writeHeaders(client),
        payload: {
          clientAttemptId: entry.key,
          itemId: item.id,
          itemRevision: item.revision,
          answer: entry.answer,
          durationMs: 1,
          occurredAt: new Date(entry.at).toISOString()
        }
      });
      assert.equal(response.statusCode, 200, response.body);
    }
    const chronologicalSummary = db.prepare(`
      SELECT total_attempts, correct_attempts, first_try_correct, current_streak, best_streak, last_attempt_at
      FROM practice_sessions WHERE id = ?
    `).get(orderedSession) as {
      total_attempts: number; correct_attempts: number; first_try_correct: number;
      current_streak: number; best_streak: number; last_attempt_at: number;
    };
    assert.deepEqual(chronologicalSummary, {
      total_attempts: 3,
      correct_attempts: 2,
      first_try_correct: 0,
      current_streak: 2,
      best_streak: 2,
      last_attempt_at: chronologicalBase + 3_000
    });
    const chronologicalFlags = db.prepare(`
      SELECT client_attempt_id, first_try_correct FROM attempts
      WHERE practice_session_id = ? ORDER BY occurred_at, client_attempt_id, id
    `).all(orderedSession) as Array<{ client_attempt_id: string; first_try_correct: number }>;
    assert.deepEqual(chronologicalFlags.map((row) => [row.client_attempt_id, row.first_try_correct]), [
      ["t1-arrived-second", 0], ["t2-arrived-third", 0], ["t3-arrived-first", 0]
    ]);
    assert.equal(
      (db.prepare("SELECT first_try_correct_count FROM progress WHERE user_id = ? AND item_id = ?").get(user.id, item.id) as {
        first_try_correct_count: number;
      }).first_try_correct_count,
      2
    );

    const insertAttempt = db.prepare(`
      INSERT INTO attempts(
        id, client_attempt_id, practice_session_id, user_id, item_id, item_revision, request_hash,
        correct, first_try_correct, duration_ms, occurred_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, 0, ?, ?)
    `);
    const recentNow = Date.now();
    db.transaction(() => {
      for (let index = 0; index < 120; index += 1) {
        insertAttempt.run(randomUUID(), randomUUID(), concurrentSession, user.id, item.id, item.revision, `rate-${index}`, recentNow, recentNow);
      }
    })();
    const limited = await app.inject({
      method: "POST",
      url: `/api/practice/sessions/${concurrentSession}/attempts`,
      headers: writeHeaders(client),
      payload: { clientAttemptId: randomUUID(), itemId: item.id, itemRevision: item.revision, answer: "x", durationMs: 0 }
    });
    assert.equal(limited.statusCode, 429, limited.body);
    assert.equal(limited.json().error.code, "ATTEMPT_RATE_LIMITED");

    const oldId = randomUUID();
    insertAttempt.run(
      oldId, randomUUID(), concurrentSession, user.id, item.id, item.revision, "old", Date.now() - 91 * 24 * 60 * 60_000,
      Date.now() - 91 * 24 * 60 * 60_000
    );
    cleanupExpiredSecurityRows(db);
    assert.equal(db.prepare("SELECT 1 FROM attempts WHERE id = ?").get(oldId), undefined);

    for (let index = 0; index < 11; index += 1) await createPracticeSession(app, client);
    const activePractice = db.prepare(`
      SELECT COUNT(*) AS active, (SELECT COUNT(*) FROM practice_sessions WHERE user_id = ?) AS total
      FROM practice_sessions WHERE user_id = ? AND finished_at IS NULL
    `).get(user.id, user.id) as { active: number; total: number };
    assert.equal(activePractice.active, 1);
    assert.ok(activePractice.total > 10);

    const userRow = db.prepare("SELECT * FROM users WHERE id = ?").get(user.id) as UserRow;
    const fakeReply = { setCookie() {} } as unknown as FastifyReply;
    const fakeRequest = { ip: "127.0.0.1", headers: {} } as unknown as FastifyRequest;
    for (let index = 0; index < 11; index += 1) createSession(db, fakeReply, fakeRequest, userRow);
    const authSessions = db.prepare(`
      SELECT COUNT(*) AS count FROM sessions WHERE user_id = ? AND revoked_at IS NULL
    `).get(user.id) as { count: number };
    assert.equal(authSessions.count, 10);
  } finally {
    await closeFixture(app, db);
  }
});

test("published edits become drafts until publish, and CSV previews are creator-bound and atomically committed", async () => {
  const { app, db } = await fixture();
  try {
    const adminA = await insertUser(db, "content.admin.a", "Content-Admin-A!", "admin");
    await insertUser(db, "content.admin.b", "Content-Admin-B!", "admin");
    const clientA = await login(app, adminA.username, "Content-Admin-A!");
    const clientB = await login(app, "content.admin.b", "Content-Admin-B!");
    const before = await getContent(app, clientA);
    const item = before.items[0]!;
    const itemEdit = await app.inject({
      method: "PATCH",
      url: `/api/admin/items/${item.id}`,
      headers: writeHeaders(clientA),
      payload: { english: "edited unpublished answer" }
    });
    assert.equal(itemEdit.statusCode, 200, itemEdit.body);
    assert.equal(itemEdit.json().item.status, "draft");
    const whileDraft = await getContent(app, clientA);
    assert.ok(!whileDraft.items.some((candidate) => candidate.id === item.id));
    assert.notEqual(whileDraft.version, before.version);
    const itemPublish = await app.inject({
      method: "POST", url: `/api/admin/items/${item.id}/publish`, headers: writeHeaders(clientA), payload: {}
    });
    assert.equal(itemPublish.statusCode, 200, itemPublish.body);
    const afterPublish = await getContent(app, clientA);
    assert.equal(afterPublish.items.find((candidate) => candidate.id === item.id)?.english, "edited unpublished answer");

    const categoryId = afterPublish.items[1]!.categoryId;
    const categoryBefore = afterPublish.categories.find((category) => category.id === categoryId)!;
    const categoryEdit = await app.inject({
      method: "PATCH",
      url: `/api/admin/categories/${categoryId}`,
      headers: writeHeaders(clientA),
      payload: { name: `${categoryBefore.name} draft` }
    });
    assert.equal(categoryEdit.statusCode, 200, categoryEdit.body);
    assert.equal(categoryEdit.json().category.status, "draft");
    assert.ok(!(await getContent(app, clientA)).categories.some((category) => category.id === categoryId));
    const categoryPublish = await app.inject({
      method: "POST", url: `/api/admin/categories/${categoryId}/publish`, headers: writeHeaders(clientA), payload: {}
    });
    assert.equal(categoryPublish.statusCode, 200, categoryPublish.body);
    assert.equal((await getContent(app, clientA)).categories.find((category) => category.id === categoryId)?.name, `${categoryBefore.name} draft`);

    const categoryCreate = await app.inject({
      method: "POST",
      url: "/api/admin/categories",
      headers: writeHeaders(clientA),
      payload: { slug: "csv-atomic", name: "CSV Atomic", kind: "word" }
    });
    assert.equal(categoryCreate.statusCode, 200, categoryCreate.body);
    const emptyCategoryId = categoryCreate.json().category.id as string;
    const anonymous = await guest(app);
    const rejectedBeforeLargeImport = await app.inject({
      method: "POST",
      url: "/api/admin/imports/preview",
      headers: writeHeaders(anonymous),
      payload: { csv: "x".repeat(100_000) }
    });
    assert.equal(rejectedBeforeLargeImport.statusCode, 401, rejectedBeforeLargeImport.body);

    const largeCsv = [
      "key,categoryId,kind,english,meaning,sortOrder,status",
      ...Array.from({ length: 900 }, (_, index) =>
        `large-${index},${emptyCategoryId},word,largeword${index},批量词条${index},${index},draft`)
    ].join("\n");
    assert.ok(Buffer.byteLength(JSON.stringify({ csv: largeCsv }), "utf8") > 64 * 1024);
    const largePreview = await app.inject({
      method: "POST",
      url: "/api/admin/imports/preview",
      headers: writeHeaders(clientA),
      payload: { csv: largeCsv }
    });
    assert.equal(largePreview.statusCode, 200, largePreview.body);
    assert.deepEqual(largePreview.json().errors, []);

    const csv = `key,categoryId,kind,english,meaning,sortOrder,status\ncsv-atomic-item,${emptyCategoryId},word,atomic,原子,1,draft`;
    const preview = await app.inject({
      method: "POST", url: "/api/admin/imports/preview", headers: writeHeaders(clientA), payload: { csv }
    });
    assert.equal(preview.statusCode, 200, preview.body);
    assert.deepEqual(preview.json().errors, []);
    const previewId = preview.json().previewId as string;
    const foreignCommit = await app.inject({
      method: "POST", url: "/api/admin/imports/commit", headers: writeHeaders(clientB), payload: { previewId }
    });
    assert.equal(foreignCommit.statusCode, 404, foreignCommit.body);

    db.prepare("UPDATE categories SET kind = 'sentence' WHERE id = ?").run(emptyCategoryId);
    const changedCommit = await app.inject({
      method: "POST", url: "/api/admin/imports/commit", headers: writeHeaders(clientA), payload: { previewId }
    });
    assert.equal(changedCommit.statusCode, 409, changedCommit.body);
    assert.equal(changedCommit.json().error.code, "IMPORT_CATEGORY_CHANGED");
    assert.equal(db.prepare("SELECT 1 FROM items WHERE item_key = 'csv-atomic-item'").get(), undefined);
    assert.equal(
      (db.prepare("SELECT committed_at FROM import_previews WHERE id = ?").get(previewId) as { committed_at: number | null }).committed_at,
      null
    );
  } finally {
    await closeFixture(app, db);
  }
});

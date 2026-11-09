import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import type { UserRow } from "../src/auth.js";
import { migrateDatabase, openDatabase, type SqliteDatabase } from "../src/database.js";
import { extendMembership, getMembershipAccess, type MembershipRow } from "../src/membership.js";
import { hashPassword } from "../src/security.js";

const ORIGIN = "https://english.test";
const DAY = 86_400_000;
const PASSWORD = "membership-fixture-password-123!";

function addUser(db: SqliteDatabase, username: string, now: number, role = "user", passwordHash = "unusable-fixture-hash"): UserRow {
  const id = randomUUID();
  db.prepare(`INSERT INTO users(id,username,display_name,password_hash,role,active,must_change_password,created_at,updated_at)
    VALUES (?,?,?,?,?,1,0,?,?)`).run(id, username, username, passwordHash, role, now, now);
  return db.prepare("SELECT * FROM users WHERE id = ?").get(id) as UserRow;
}

test("schema 5 preserves old users as free and starts exactly one trial for future inserts", () => {
  const db = openDatabase({ databasePath: ":memory:" });
  try {
    migrateDatabase(db);
    // Reconstruct the previous schema; all prior migration SQL/checksums remain intact.
    db.exec(`DROP TRIGGER users_start_membership_trial; DROP TABLE payment_orders; DROP TABLE user_memberships;
      DELETE FROM schema_migrations WHERE version = 5;`);
    const old = addUser(db, "old.account", Date.now() - 20 * DAY);
    assert.equal(migrateDatabase(db), 5);
    assert.equal(getMembershipAccess(db, old, true).status, "legacy_free");
    assert.equal(getMembershipAccess(db, old, true).expiresAt, null);
    const now = Date.now();
    const fresh = addUser(db, "new.account", now);
    const row = db.prepare("SELECT * FROM user_memberships WHERE user_id = ?").get(fresh.id) as MembershipRow;
    assert.equal(row.access_kind, "metered");
    assert.equal(row.trial_started_at, now);
    assert.equal(row.trial_ends_at, now + DAY);
    assert.equal(getMembershipAccess(db, fresh, true, now + DAY - 1).canPractice, true);
    assert.equal(getMembershipAccess(db, fresh, true, now + DAY).status, "expired");
    assert.equal(getMembershipAccess(db, fresh, false, now + 2 * DAY).status, "disabled");
    assert.equal(getMembershipAccess(db, { ...fresh, role: "admin" }, true, now + 2 * DAY).status, "admin");
    db.prepare("UPDATE users SET email = ?, email_verified_at = ? WHERE id = ?").run("bound@example.com", now, fresh.id);
    assert.equal(migrateDatabase(db), 5);
    assert.deepEqual(db.prepare("SELECT * FROM user_memberships WHERE user_id = ?").get(fresh.id), row);
    assert.equal(getMembershipAccess(db, old, true, now + 100 * DAY).canPractice, true);
    // Missing membership metadata never silently grants lifetime access.
    db.prepare("DELETE FROM user_memberships WHERE user_id = ?").run(fresh.id);
    assert.equal(getMembershipAccess(db, fresh, true).status, "expired");
  } finally { db.close(); }
});

test("renewals preserve unused trial/paid time and expired memberships start from payment confirmation", () => {
  const db = openDatabase({ databasePath: ":memory:" });
  try {
    migrateDatabase(db);
    const now = Date.now();
    const user = addUser(db, "renewals", now);
    const first = db.transaction(() => extendMembership(db, user.id, 30, now + 1_000)).immediate();
    assert.equal(first, now + 31 * DAY);
    assert.equal(getMembershipAccess(db, user, true, now + 2_000).status, "active");
    assert.equal(db.transaction(() => extendMembership(db, user.id, 30, now + DAY)).immediate(), now + 61 * DAY);
    assert.equal(db.transaction(() => extendMembership(db, user.id, 30, now + 90 * DAY)).immediate(), now + 120 * DAY);
    assert.throws(() => extendMembership(db, user.id, 31, now), /Invalid membership/);
    assert.equal(getMembershipAccess(db, user, true, now + 120 * DAY).canPractice, false);
  } finally { db.close(); }
});

function cookie(headers: Record<string, string | string[] | undefined>): string {
  const raw = headers["set-cookie"];
  const value = Array.isArray(raw) ? raw[0] : raw;
  assert.ok(value);
  return value.split(";", 1)[0]!;
}

async function login(app: FastifyInstance, username: string) {
  const guest = await app.inject({ method: "GET", url: "/api/auth/session" });
  const result = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username, password: PASSWORD },
    headers: { cookie: cookie(guest.headers), origin: ORIGIN, "x-csrf-token": guest.json().csrfToken } });
  assert.equal(result.statusCode, 200, result.body);
  return { cookie: cookie(result.headers), origin: ORIGIN, "x-csrf-token": result.json().csrfToken as string };
}

async function fixture(enabled = true) {
  const db = openDatabase({ databasePath: ":memory:" });
  const app = await buildApp({ database: db, seed: false, logger: false,
    config: { environment: "test", appOrigin: ORIGIN, membershipEnabled: enabled } });
  const now = Date.now();
  const hash = await hashPassword(PASSWORD);
  const user = addUser(db, "trial.user", now, "user", hash);
  const admin = addUser(db, "admin.user", now, "admin", hash);
  db.prepare(`INSERT INTO categories(id,slug,name,kind,status,created_at,updated_at)
    VALUES ('category','category','Category','word','published',?,?)`).run(now, now);
  db.prepare(`INSERT INTO items(id,item_key,category_id,kind,english,meaning,normalized_answer,status,created_at,updated_at)
    VALUES ('item','item','category','word','hello','你好','hello','published',?,?)`).run(now, now);
  return { db, app, user, admin };
}

test("expiry locks all practice APIs but preserves login, history and accepted attempt replay", async () => {
  const { db, app, user } = await fixture();
  try {
    const headers = await login(app, user.username);
    const session = await app.inject({ method: "POST", url: "/api/practice/sessions", headers, payload: { mode: "sequential" } });
    assert.equal(session.statusCode, 200, session.body);
    const id = session.json().session.id;
    const attempt = { clientAttemptId: randomUUID(), itemId: "item", itemRevision: 1, answer: "wrong", durationMs: 100 };
    const before = await app.inject({ method: "POST", url: `/api/practice/sessions/${id}/attempts`, headers, payload: attempt });
    assert.equal(before.statusCode, 200, before.body);
    db.prepare("UPDATE user_memberships SET trial_ends_at = ? WHERE user_id = ?").run(Date.now() - 1, user.id);
    for (const url of ["/api/content", "/api/practice/import-batches/unknown"]) {
      const locked = await app.inject({ method: "GET", url, headers });
      assert.equal(locked.statusCode, 403, locked.body);
      assert.equal(locked.json().error.code, "MEMBERSHIP_REQUIRED");
    }
    const create = await app.inject({ method: "POST", url: "/api/practice/sessions", headers, payload: { mode: "random" } });
    assert.equal(create.statusCode, 403);
    const newAttempt = await app.inject({ method: "POST", url: `/api/practice/sessions/${id}/attempts`, headers,
      payload: { ...attempt, clientAttemptId: randomUUID() } });
    assert.equal(newAttempt.statusCode, 403);
    const replay = await app.inject({ method: "POST", url: `/api/practice/sessions/${id}/attempts`, headers, payload: attempt });
    assert.equal(replay.statusCode, 200, replay.body);
    assert.deepEqual(replay.json(), before.json());
    const mistakes = await app.inject({ method: "GET", url: "/api/me/mistakes", headers });
    assert.deepEqual(mistakes.json(), { items: [], locked: true, total: 1 });
    const history = await app.inject({ method: "GET", url: "/api/me/summary", headers });
    assert.equal(history.statusCode, 200);
    assert.equal(history.json().totals.attempts, 1);
    assert.equal((await app.inject({ method: "GET", url: "/api/auth/session", headers })).json().user.id, user.id);
    const membership = await app.inject({ method: "GET", url: "/api/membership", headers });
    assert.equal(membership.statusCode, 200, membership.body);
    assert.equal(membership.json().access.status, "expired");
    assert.deepEqual(membership.json().plan, { id: "monthly", priceFen: 100, durationDays: 30 });
    assert.equal(membership.json().paymentEnabled, false);
    const profile = await app.inject({ method: "PATCH", url: "/api/me/profile", headers,
      payload: { displayName: "学习者", role: "admin", username: "hacked", email: "hacked@example.com" } });
    assert.equal(profile.statusCode, 200, profile.body);
    assert.equal(profile.json().user.displayName, "学习者");
    assert.equal(profile.json().user.role, "user");
    assert.equal(profile.json().user.username, user.username);
    assert.equal(profile.json().user.email, undefined);
    assert.ok(db.prepare("SELECT 1 FROM audit_log WHERE actor_user_id = ? AND action = 'user.profile_updated'").get(user.id));
    assert.equal((await app.inject({ method: "PATCH", url: "/api/me/profile", headers, payload: { displayName: " " } })).statusCode, 422);
    const finish = await app.inject({ method: "POST", url: `/api/practice/sessions/${id}/finish`, headers, payload: {} });
    assert.equal(finish.statusCode, 200);
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM attempts").get() as { n: number }).n, 1);
  } finally { await app.close(); db.close(); }
});

test("administrator-created accounts get one trial, admins and grandfathered users retain access", async () => {
  const { db, app, user, admin } = await fixture();
  try {
    const adminHeaders = await login(app, admin.username);
    db.prepare("UPDATE user_memberships SET trial_ends_at = trial_started_at").run();
    assert.equal((await app.inject({ method: "GET", url: "/api/content", headers: adminHeaders })).statusCode, 200);
    const created = await app.inject({ method: "POST", url: "/api/admin/users", headers: adminHeaders,
      payload: { username: "new.from.admin", displayName: "New user", role: "user" } });
    assert.equal(created.statusCode, 200, created.body);
    const row = db.prepare("SELECT * FROM user_memberships WHERE user_id = ?").get(created.json().user.id) as MembershipRow;
    assert.equal(row.access_kind, "metered");
    assert.equal(row.trial_ends_at! - row.trial_started_at!, DAY);
    db.prepare("UPDATE user_memberships SET access_kind = 'legacy_free' WHERE user_id = ?").run(user.id);
    const headers = await login(app, user.username);
    assert.equal((await app.inject({ method: "GET", url: "/api/content", headers })).statusCode, 200);
    assert.equal((await app.inject({ method: "GET", url: "/api/membership", headers })).json().access.status, "legacy_free");
  } finally { await app.close(); db.close(); }
});

test("disabled rollout flag leaves an expired ordinary account's practice usable", async () => {
  const { db, app, user } = await fixture(false);
  try {
    db.prepare("UPDATE user_memberships SET trial_ends_at = trial_started_at WHERE user_id = ?").run(user.id);
    const headers = await login(app, user.username);
    assert.equal((await app.inject({ method: "GET", url: "/api/content", headers })).statusCode, 200);
    const status = (await app.inject({ method: "GET", url: "/api/membership", headers })).json();
    assert.equal(status.enabled, false);
    assert.equal(status.paymentEnabled, false);
    assert.equal(status.access.status, "disabled");
  } finally { await app.close(); db.close(); }
});

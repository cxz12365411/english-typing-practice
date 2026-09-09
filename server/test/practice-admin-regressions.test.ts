import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import test from "node:test";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { buildApp } from "../src/app.js";
import { createSession, type UserRow } from "../src/auth.js";
import { openDatabase } from "../src/database.js";

const ORIGIN = "https://english.test";
type Client = { id: string; cookie: string; csrf: string };
type Item = { id: string; key: string; categoryId: string; kind: "word" | "sentence"; english: string; meaning: string; revision: number };

async function fixture() {
  const db = openDatabase({ databasePath: ":memory:" });
  const app = await buildApp({ database: db, logger: false, config: {
    databasePath: ":memory:", appOrigin: ORIGIN,
    contentSourceDir: resolve(import.meta.dirname, "../.."),
    guestTokenSecret: "test-guest-token-secret-at-least-32-bytes"
  } });
  function client(role: "user" | "admin" = "user"): Client {
    const id = randomUUID();
    const now = Date.now();
    db.prepare(`INSERT INTO users(id, username, display_name, password_hash, role, active, must_change_password, created_at, updated_at)
      VALUES (?, ?, 'Regression fixture', 'unused-test-only-hash', ?, 1, 0, ?, ?)`)
      .run(id, `test-${id.slice(0, 8)}`, role, now, now);
    const user = db.prepare("SELECT * FROM users WHERE id = ?").get(id) as UserRow;
    let cookie = "";
    const reply = { setCookie(name: string, value: string) { cookie = `${name}=${value}`; } } as unknown as FastifyReply;
    const auth = createSession(db, reply, { ip: "127.0.0.1", headers: {} } as FastifyRequest, user);
    return { id, cookie, csrf: auth.csrfToken };
  }
  return { app, db, client, async close() { await app.close(); db.close(); } };
}

function headers(client: Client) {
  return { cookie: client.cookie, origin: ORIGIN, "x-csrf-token": client.csrf };
}

async function content(app: FastifyInstance, client: Client): Promise<{ version: string; items: Item[] }> {
  const response = await app.inject({ method: "GET", url: "/api/content", headers: headers(client) });
  assert.equal(response.statusCode, 200, response.body);
  return response.json();
}

async function session(app: FastifyInstance, client: Client): Promise<string> {
  const response = await app.inject({ method: "POST", url: "/api/practice/sessions", headers: headers(client), payload: { mode: "sequential" } });
  assert.equal(response.statusCode, 200, response.body);
  return response.json().session.id;
}

async function submit(app: FastifyInstance, client: Client, sessionId: string, item: Item, extra: Record<string, unknown> = {}) {
  return app.inject({ method: "POST", url: `/api/practice/sessions/${sessionId}/attempts`, headers: headers(client), payload: {
    clientAttemptId: randomUUID(), itemId: item.id, itemRevision: item.revision, answer: item.english, durationMs: 1_200, ...extra
  } });
}

test("finishing a session cannot reduce recorded duration and replay keeps cumulative totals stable", async () => {
  const f = await fixture();
  try {
    const user = f.client();
    const item = (await content(f.app, user)).items[0]!;
    const sessionId = await session(f.app, user);
    const request = { clientAttemptId: "duration-regression", occurredAt: new Date().toISOString() };
    assert.equal((await submit(f.app, user, sessionId, item, request)).statusCode, 200);
    const finish = await f.app.inject({ method: "POST", url: `/api/practice/sessions/${sessionId}/finish`, headers: headers(user), payload: { durationMs: 0 } });
    assert.equal(finish.statusCode, 200, finish.body);
    assert.equal(finish.json().session.durationMs, 1_200);
    assert.equal((await submit(f.app, user, sessionId, item, request)).statusCode, 200);
    const again = await f.app.inject({ method: "POST", url: `/api/practice/sessions/${sessionId}/finish`, headers: headers(user), payload: { durationMs: 9_999 } });
    assert.equal(again.json().session.durationMs, 1_200);
    const totals = (await f.app.inject({ method: "GET", url: "/api/me/summary", headers: headers(user) })).json().totals;
    assert.equal(totals.attempts, 1);
    assert.equal(totals.firstTryCorrect, 1);
    assert.equal(totals.durationMs, 1_200);
  } finally { await f.close(); }
});

test("same-millisecond out-of-order attempts agree on streak, first try, and mistake state", async () => {
  const f = await fixture();
  try {
    const user = f.client();
    const item = (await content(f.app, user)).items[0]!;
    const sessionId = await session(f.app, user);
    const occurredAt = new Date().toISOString();
    assert.equal((await submit(f.app, user, sessionId, item, { clientAttemptId: "z-correct-last", occurredAt })).statusCode, 200);
    const older = await submit(f.app, user, sessionId, item, { clientAttemptId: "a-wrong-first", answer: "incorrect", occurredAt });
    assert.equal(older.statusCode, 200, older.body);
    assert.equal(older.json().summary.streak, 1);
    assert.equal(older.json().summary.accuracy, 0.5);
    assert.equal(older.json().summary.mistakes, 0);
    const row = f.db.prepare("SELECT attempt_count, correct_count, first_try_correct_count, is_mistake FROM progress WHERE user_id = ? AND item_id = ?").get(user.id, item.id);
    assert.deepEqual(row, { attempt_count: 2, correct_count: 1, first_try_correct_count: 0, is_mistake: 0 });
  } finally { await f.close(); }
});

test("draft and archived content is excluded from learner mistakes without discarding progress", async () => {
  const f = await fixture();
  try {
    const admin = f.client("admin");
    const user = f.client();
    const item = (await content(f.app, user)).items[0]!;
    const sessionId = await session(f.app, user);
    await submit(f.app, user, sessionId, item, { answer: "wrong" });
    const edited = await f.app.inject({ method: "PATCH", url: `/api/admin/items/${item.id}`, headers: headers(admin), payload: { english: "secret unpublished draft" } });
    assert.equal(edited.statusCode, 200, edited.body);
    const mistakes = await f.app.inject({ method: "GET", url: "/api/me/mistakes", headers: headers(user) });
    assert.deepEqual(mistakes.json().items, []);
    const summary = await f.app.inject({ method: "GET", url: "/api/me/summary", headers: headers(user) });
    assert.equal(summary.json().totals.mistakes, 0);
    assert.equal((f.db.prepare("SELECT is_mistake FROM progress WHERE user_id = ? AND item_id = ?").get(user.id, item.id) as { is_mistake: number }).is_mistake, 1);
    await f.app.inject({ method: "POST", url: `/api/admin/items/${item.id}/publish`, headers: headers(admin), payload: {} });
    assert.equal((await f.app.inject({ method: "GET", url: "/api/me/mistakes", headers: headers(user) })).json().items.length, 1);
    await f.app.inject({ method: "POST", url: `/api/admin/categories/${item.categoryId}/archive`, headers: headers(admin), payload: {} });
    assert.deepEqual((await f.app.inject({ method: "GET", url: "/api/me/mistakes", headers: headers(user) })).json().items, []);
  } finally { await f.close(); }
});

test("CSV publication validates category status at preview and commit and rolls back the whole batch", async () => {
  const f = await fixture();
  try {
    const admin = f.client("admin");
    const items = (await content(f.app, admin)).items;
    const item = items[0]!;
    const other = items.find((candidate) => candidate.categoryId !== item.categoryId)!;
    const csv = `key,categoryId,kind,english,meaning,status\ncsv-first-rollback,${other.categoryId},${other.kind},first,先写入,published\ncsv-category-safe,${item.categoryId},${item.kind},safe,安全,published`;
    const preview = await f.app.inject({ method: "POST", url: "/api/admin/imports/preview", headers: headers(admin), payload: { csv } });
    assert.deepEqual(preview.json().errors, []);
    await f.app.inject({ method: "POST", url: `/api/admin/categories/${item.categoryId}/archive`, headers: headers(admin), payload: {} });
    const commit = await f.app.inject({ method: "POST", url: "/api/admin/imports/commit", headers: headers(admin), payload: { previewId: preview.json().previewId } });
    assert.equal(commit.statusCode, 409, commit.body);
    assert.equal(commit.json().error.code, "CATEGORY_NOT_PUBLISHED");
    assert.equal(f.db.prepare("SELECT 1 FROM items WHERE item_key = 'csv-category-safe'").get(), undefined);
    assert.equal(f.db.prepare("SELECT 1 FROM items WHERE item_key = 'csv-first-rollback'").get(), undefined);
    assert.equal((f.db.prepare("SELECT committed_at FROM import_previews WHERE id = ?").get(preview.json().previewId) as { committed_at: number | null }).committed_at, null);
    const invalid = await f.app.inject({ method: "POST", url: "/api/admin/imports/preview", headers: headers(admin), payload: { csv } });
    assert.ok(invalid.json().errors.some((error: { field: string }) => error.field === "status"));
  } finally { await f.close(); }
});

test("CSV previews cannot overwrite changes made after preview", async () => {
  const f = await fixture();
  try {
    const admin = f.client("admin");
    const item = (await content(f.app, admin)).items[0]!;
    const csv = `key,categoryId,kind,english,meaning,status\n${item.key},${item.categoryId},${item.kind},stale import,旧预览,draft`;
    const preview = await f.app.inject({ method: "POST", url: "/api/admin/imports/preview", headers: headers(admin), payload: { csv } });
    assert.deepEqual(preview.json().errors, []);
    const edit = await f.app.inject({ method: "PATCH", url: `/api/admin/items/${item.id}`, headers: headers(admin), payload: { english: "newer manual edit" } });
    assert.equal(edit.statusCode, 200, edit.body);
    const commit = await f.app.inject({ method: "POST", url: "/api/admin/imports/commit", headers: headers(admin), payload: { previewId: preview.json().previewId } });
    assert.equal(commit.statusCode, 409, commit.body);
    assert.equal(commit.json().error.code, "IMPORT_ITEM_CHANGED");
    assert.equal((f.db.prepare("SELECT english FROM items WHERE id = ?").get(item.id) as { english: string }).english, "newer manual edit");
  } finally { await f.close(); }
});

test("CSV rejects header-only files and duplicate columns", async () => {
  const f = await fixture();
  try {
    const admin = f.client("admin");
    const item = (await content(f.app, admin)).items[0]!;
    for (const csv of ["key,english,meaning", `key,categoryId,english,english,meaning\ndup,${item.categoryId},one,two,中文`]) {
      const response = await f.app.inject({ method: "POST", url: "/api/admin/imports/preview", headers: headers(admin), payload: { csv } });
      assert.equal(response.statusCode, 200, response.body);
      assert.ok(response.json().errors.length > 0, response.body);
    }
  } finally { await f.close(); }
});

test("a CSV insert preview cannot become an unintended overwrite, while successful imports preserve item identity and history", async () => {
  const f = await fixture();
  try {
    const admin = f.client("admin");
    const item = (await content(f.app, admin)).items[0]!;
    const csv = `key,categoryId,kind,english,meaning,status\ncsv-collision,${item.categoryId},${item.kind},from csv,导入,draft`;
    const preview = await f.app.inject({ method: "POST", url: "/api/admin/imports/preview", headers: headers(admin), payload: { csv } });
    assert.deepEqual(preview.json().errors, []);
    const created = await f.app.inject({ method: "POST", url: "/api/admin/items", headers: headers(admin), payload: {
      key: "csv-collision", categoryId: item.categoryId, english: "manual value", meaning: "手动"
    } });
    assert.equal(created.statusCode, 200, created.body);
    const collision = await f.app.inject({ method: "POST", url: "/api/admin/imports/commit", headers: headers(admin), payload: { previewId: preview.json().previewId } });
    assert.equal(collision.statusCode, 409, collision.body);
    assert.equal(collision.json().error.code, "IMPORT_ITEM_CHANGED");
    const refreshed = await f.app.inject({ method: "POST", url: "/api/admin/imports/preview", headers: headers(admin), payload: { csv } });
    const committed = await f.app.inject({ method: "POST", url: "/api/admin/imports/commit", headers: headers(admin), payload: { previewId: refreshed.json().previewId } });
    assert.equal(committed.statusCode, 200, committed.body);
    assert.deepEqual(committed.json(), { ok: true, created: 0, updated: 1 });
    const itemId = created.json().item.id;
    const stored = f.db.prepare("SELECT id, english, revision FROM items WHERE item_key = 'csv-collision'").get();
    assert.deepEqual(stored, { id: itemId, english: "from csv", revision: 2 });
    const snapshots = f.db.prepare("SELECT action, snapshot_json FROM item_revisions WHERE item_id = ? ORDER BY revision").all(itemId) as Array<{ action: string; snapshot_json: string }>;
    assert.deepEqual(snapshots.map((row) => [row.action, JSON.parse(row.snapshot_json).english]), [["create", "manual value"], ["csv_update", "from csv"]]);
    const duplicateCommit = await f.app.inject({ method: "POST", url: "/api/admin/imports/commit", headers: headers(admin), payload: { previewId: refreshed.json().previewId } });
    assert.equal(duplicateCommit.statusCode, 409, duplicateCommit.body);
    assert.equal(duplicateCommit.json().error.code, "IMPORT_ALREADY_COMMITTED");
  } finally { await f.close(); }
});

test("no-op edits preserve publication and repeated publish preserves the revision history", async () => {
  const f = await fixture();
  try {
    const admin = f.client("admin");
    const before = await content(f.app, admin);
    const item = before.items[0]!;
    const beforeHistory = f.db.prepare("SELECT COUNT(*) AS n FROM item_revisions WHERE item_id = ?").get(item.id);
    const edited = await f.app.inject({ method: "PATCH", url: `/api/admin/items/${item.id}`, headers: headers(admin), payload: { english: item.english } });
    assert.equal(edited.statusCode, 200, edited.body);
    assert.equal(edited.json().item.status, "published");
    assert.equal(edited.json().item.revision, item.revision);
    const published = await f.app.inject({ method: "POST", url: `/api/admin/items/${item.id}/publish`, headers: headers(admin), payload: {} });
    assert.equal(published.statusCode, 200, published.body);
    assert.equal(published.json().item.revision, item.revision);
    const category = await f.app.inject({ method: "PATCH", url: `/api/admin/categories/${item.categoryId}`, headers: headers(admin), payload: {} });
    assert.equal(category.json().category.status, "published");
    assert.equal((await content(f.app, admin)).version, before.version);
    assert.deepEqual(f.db.prepare("SELECT COUNT(*) AS n FROM item_revisions WHERE item_id = ?").get(item.id), beforeHistory);
  } finally { await f.close(); }
});

test("sessions and idempotency keys remain account-bound, and the last active administrator is protected", async () => {
  const f = await fixture();
  try {
    const admin = f.client("admin");
    const userA = f.client();
    const userB = f.client();
    const item = (await content(f.app, userA)).items[0]!;
    const sessionA = await session(f.app, userA);
    const sessionB = await session(f.app, userB);
    assert.equal((await submit(f.app, userB, sessionA, item)).statusCode, 404);
    assert.equal((await f.app.inject({ method: "POST", url: `/api/practice/sessions/${sessionA}/finish`, headers: headers(userB), payload: {} })).statusCode, 404);
    const shared = { clientAttemptId: "shared-account-key", occurredAt: new Date().toISOString() };
    assert.equal((await submit(f.app, userA, sessionA, item, shared)).statusCode, 200);
    assert.equal((await submit(f.app, userB, sessionB, item, shared)).statusCode, 200);
    assert.equal((await submit(f.app, userA, sessionA, item, { ...shared, answer: "other" })).statusCode, 409);
    for (const payload of [{ active: false }, { role: "user" }]) {
      const response = await f.app.inject({ method: "PATCH", url: `/api/admin/users/${admin.id}`, headers: headers(admin), payload });
      assert.equal(response.statusCode, 409, response.body);
      assert.equal(response.json().error.code, "LAST_ADMIN");
    }
    const deleted = await f.app.inject({ method: "DELETE", url: `/api/admin/users/${admin.id}`, headers: headers(admin) });
    assert.equal(deleted.statusCode, 409, deleted.body);
    assert.equal(deleted.json().error.code, "LAST_ADMIN");
  } finally { await f.close(); }
});

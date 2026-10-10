import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import type { FastifyReply, FastifyRequest } from "fastify";
import { buildApp } from "../src/app.js";
import { createSession, type UserRow } from "../src/auth.js";
import { migrateDatabase, openDatabase } from "../src/database.js";
import { normalizeAnswer } from "../src/security.js";

const ORIGIN = "https://english.test";
type Client = { id: string; cookie: string; csrf: string };
const sample = (title = "街头摄影", english = "Could you smile?") => `## ${title}\n\n| 英文 | 中文释义 | 中文谐音 |\n| --- | --- | --- |\n| ${english} | 可以笑一下吗？ | 库德 油 斯迈尔 |`;

async function fixture() {
  const db = openDatabase({ databasePath: ":memory:" });
  const app = await buildApp({ database: db, logger: false, config: {
    databasePath: ":memory:", appOrigin: ORIGIN, contentSourceDir: resolve(import.meta.dirname, "../.."),
    guestTokenSecret: "test-guest-token-secret-at-least-32-bytes"
  } });
  function client(role: "user" | "admin" = "admin"): Client {
    const id = randomUUID();
    db.prepare(`INSERT INTO users(id, username, display_name, password_hash, role, active, must_change_password, created_at, updated_at)
      VALUES (?, ?, 'Import fixture', 'unused-test-only-hash', ?, 1, 0, ?, ?)`)
      .run(id, `test-${id.slice(0, 8)}`, role, Date.now(), Date.now());
    const user = db.prepare("SELECT * FROM users WHERE id = ?").get(id) as UserRow;
    let cookie = "";
    const reply = { setCookie(name: string, value: string) { cookie = `${name}=${value}`; } } as unknown as FastifyReply;
    const auth = createSession(db, reply, { ip: "127.0.0.1", headers: {} } as FastifyRequest, user);
    return { id, cookie, csrf: auth.csrfToken };
  }
  function category(name = "街头摄影", kind: "word" | "sentence" = "sentence", status = "published") {
    const id = randomUUID();
    db.prepare(`INSERT INTO categories(id, slug, name, kind, sort_order, status, created_at, updated_at, published_at)
      VALUES (?, ?, ?, ?, 100, ?, 1, 1, 1)`).run(id, `test-${id}`, name, kind, status);
    return id;
  }
  function item(categoryId: string, english = "Could you smile?", status = "published", createdAt = 1) {
    const id = randomUUID();
    db.prepare(`INSERT INTO items(id, item_key, category_id, kind, english, meaning, pronunciation, normalized_answer,
      sort_order, revision, status, created_at, updated_at, published_at)
      VALUES (?, ?, ?, 'sentence', ?, '原释义', '原谐音', ?, 900, 7, ?, ?, 1, 1)`)
      .run(id, `test-${id}`, categoryId, english, normalizeAnswer(english), status, createdAt);
    return id;
  }
  function headers(user: Client) { return { cookie: user.cookie, origin: ORIGIN, "x-csrf-token": user.csrf }; }
  const post = (user: Client, url: string, payload: unknown) => app.inject({ method: "POST", url, headers: headers(user), payload: payload as object });
  const get = (user: Client, url: string) => app.inject({ method: "GET", url, headers: headers(user) });
  const preview = (user: Client, markdown: string, extra: Record<string, unknown> = {}) => post(user, "/api/admin/markdown-imports/preview", { markdown, ...extra });
  const commit = (user: Client, previewId: string) => post(user, "/api/admin/markdown-imports/commit", { previewId });
  const version = () => (db.prepare("SELECT value FROM app_meta WHERE key = 'content_version'").get() as { value: string }).value;
  const count = (table: string) => (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
  return { app, db, client, category, item, post, get, preview, commit, version, count, headers, async close() { await app.close(); db.close(); } };
}

test("Markdown publishes atomically in file order, creates reusable batches, and retries after preview cleanup", async () => {
  const f = await fixture();
  try {
    const admin = f.client();
    const initialItems = f.count("items");
    const initialVersion = f.version();
    const preview = await f.preview(admin, sample() + "\n| Thank you. | 谢谢。 | 三克 油 |", { fileName: "photos.md" });
    assert.equal(preview.statusCode, 200, preview.body);
    assert.deepEqual(preview.json().errors, []);
    assert.equal(preview.json().summary.created, 2);
    assert.equal(f.count("items"), initialItems);
    const [first, retry] = await Promise.all([f.commit(admin, preview.json().previewId), f.commit(admin, preview.json().previewId)]);
    assert.equal(first.statusCode, 200, first.body);
    assert.deepEqual(retry.json(), first.json());
    assert.equal(f.count("items"), initialItems + 2);
    assert.notEqual(f.version(), initialVersion);
    const batchId = first.json().batchId;
    const loaded = await f.get(admin, `/api/practice/import-batches/${batchId}`);
    assert.equal(loaded.statusCode, 200, loaded.body);
    assert.deepEqual(loaded.json().items.map((item: { english: string }) => item.english), ["Could you smile?", "Thank you."]);
    assert.equal(loaded.json().batch.fileName, "photos.md");
    assert.equal(loaded.json().unavailableCount, 0);
    assert.equal((f.db.prepare("SELECT payload_json FROM import_previews WHERE id = ?").get(preview.json().previewId) as { payload_json: string }).payload_json, "{}");
    f.db.prepare("DELETE FROM import_previews WHERE id = ?").run(preview.json().previewId);
    assert.deepEqual((await f.commit(admin, preview.json().previewId)).json(), first.json());
    assert.equal(f.count("import_batches"), 1);
    assert.equal((await f.get(f.client("user"), "/api/content")).json().items.length, initialItems + 2);
  } finally { await f.close(); }
});

test("Markdown reuse never overwrites existing content, prefers published matches, and all-duplicate batches do not bump version", async () => {
  const f = await fixture();
  try {
    const admin = f.client();
    const category = f.category("句型：街头摄影");
    f.item(category, "Could you smile?", "draft", 0);
    const oldId = f.item(category, "Could you smile?", "published", 5);
    f.item(category, "Could you smile?", "published", 6);
    const before = f.db.prepare("SELECT * FROM items ORDER BY id").all();
    const version = f.version();
    const preview = await f.preview(admin, sample("一、街头摄影") + "\n| could you smile? | 替换释义 | 替换谐音 |");
    assert.deepEqual(preview.json().errors, []);
    assert.equal(preview.json().rows[0].itemId, oldId);
    assert.equal(preview.json().rows[0].meaning, "原释义");
    assert.deepEqual(preview.json().summary, { total: 2, created: 0, reused: 1, unavailable: 0, duplicates: 1, practiceCount: 1, ignoredCount: 0 });
    const result = await f.commit(admin, preview.json().previewId);
    assert.equal(result.statusCode, 200, result.body);
    assert.equal(f.version(), version);
    assert.deepEqual(f.db.prepare("SELECT * FROM items ORDER BY id").all(), before);
    assert.equal((await f.get(admin, `/api/practice/import-batches/${result.json().batchId}`)).json().items[0].id, oldId);
  } finally { await f.close(); }
});

test("deduplication occurs after category mapping and merges same new categories", async () => {
  const f = await fixture();
  try {
    const admin = f.client();
    const source = sample("第一组") + "\n\n" + sample("第二组");
    const initial = await f.preview(admin, source);
    const mappings = initial.json().groups.map((group: { groupId: string }) => ({ groupId: group.groupId, name: "合并分类", kind: "sentence" }));
    const preview = await f.preview(admin, source, { mappings });
    assert.equal(preview.json().summary.created, 1);
    assert.equal(preview.json().summary.duplicates, 1);
    assert.equal((await f.commit(admin, preview.json().previewId)).statusCode, 200);
    assert.equal((f.db.prepare("SELECT COUNT(*) AS n FROM categories WHERE name = '句型：合并分类'").get() as { n: number }).n, 1);
    const targetId = (f.db.prepare("SELECT id FROM categories WHERE name = '句型：合并分类'").get() as { id: string }).id;
    const remapped = await f.preview(admin, source, { mappings: mappings.map((mapping: { groupId: string }) => ({ groupId: mapping.groupId, categoryId: targetId })) });
    assert.equal(remapped.json().summary.reused, 1);
    assert.equal(remapped.json().summary.duplicates, 1);
  } finally { await f.close(); }
});

test("existing complete word and sentence source files reuse every published item without duplicates", async () => {
  const f = await fixture();
  try {
    const admin = f.client();
    const before = f.count("items");
    const version = f.version();
    for (const [fileName, count] of [["basic-english-850.md", 850], ["daily-english-high-frequency-sentences.md", 238]] as const) {
      const markdown = readFileSync(resolve(import.meta.dirname, "../..", fileName), "utf8");
      const preview = await f.preview(admin, markdown, { fileName });
      assert.deepEqual(preview.json().errors, []);
      assert.equal(preview.json().summary.created, 0);
      assert.equal(preview.json().summary.reused, count);
      const result = await f.commit(admin, preview.json().previewId);
      assert.equal(result.statusCode, 200, result.body);
      assert.equal(result.json().practiceCount, count);
    }
    assert.equal(f.count("items"), before);
    assert.equal(f.version(), version);
  } finally { await f.close(); }
});

test("category normalization removes exactly one type prefix and future uploads reuse the same category", async () => {
  const f = await fixture();
  try {
    const admin = f.client();
    const markdown = sample("句型：单词：摄影");
    const preview = await f.preview(admin, markdown);
    assert.equal(preview.json().groups[0].name, "句型：单词:摄影");
    assert.equal((await f.commit(admin, preview.json().previewId)).statusCode, 200);
    const again = await f.preview(admin, markdown);
    assert.equal(again.json().summary.created, 0);
    assert.equal(again.json().summary.reused, 1);
    assert.equal(again.json().groups[0].action, "existing");
  } finally { await f.close(); }
});

test("mixed inferred kinds can be resolved with an explicit preview type without hiding malformed records", async () => {
  const f = await fixture();
  try {
    const admin = f.client();
    const markdown = "## Mixed\n- **camera**：相机\n  中文谐音：开么惹\n\n| 英文 | 中文释义 |\n| --- | --- |\n| Could you smile? | 可以笑一下吗？ |";
    const initial = await f.preview(admin, markdown);
    assert.ok(initial.json().errors.some((issue: { field: string }) => issue.field === "kind"));
    const mappings = [{ groupId: initial.json().groups[0].groupId, kind: "sentence" }];
    const fixed = await f.preview(admin, markdown, { mappings });
    assert.deepEqual(fixed.json().errors, []);
    assert.ok(fixed.json().rows.every((row: { kind: string }) => row.kind === "sentence"));
    assert.equal((await f.commit(admin, fixed.json().previewId)).statusCode, 200);
    const malformed = await f.preview(admin, markdown + "\n| Missing meaning | |", { mappings });
    assert.ok(malformed.json().errors.length);
    assert.equal((await f.commit(admin, malformed.json().previewId)).statusCode, 422);
  } finally { await f.close(); }
});

test("ambiguous normalized category names require an explicit mapping; draft and archived categories never publish automatically", async () => {
  const f = await fixture();
  try {
    const admin = f.client();
    const first = f.category("句型：街头摄影");
    f.category("街头摄影");
    const preview = await f.preview(admin, sample());
    assert.equal(preview.json().groups[0].action, "ambiguous");
    assert.equal(preview.json().groups[0].candidates.length, 2);
    assert.equal((await f.commit(admin, preview.json().previewId)).statusCode, 422);
    const mapping = { groupId: preview.json().groups[0].groupId, categoryId: first };
    const mapped = await f.preview(admin, sample(), { mappings: [mapping] });
    assert.deepEqual(mapped.json().errors, []);
    for (const status of ["draft", "archived"]) {
      f.db.prepare("UPDATE categories SET status = ? WHERE id = ?").run(status, first);
      const blocked = await f.preview(admin, sample(), { mappings: [mapping] });
      assert.ok(blocked.json().errors.length);
      assert.equal((await f.commit(admin, blocked.json().previewId)).statusCode, 422);
      assert.equal((f.db.prepare("SELECT status FROM categories WHERE id = ?").get(first) as { status: string }).status, status);
    }
  } finally { await f.close(); }
});

test("archived or draft matches are skipped and zero-practice imports create no empty batch or category", async () => {
  const f = await fixture();
  try {
    const admin = f.client();
    const category = f.category();
    f.item(category, "Could you smile?", "archived");
    const before = { categories: f.count("categories"), items: f.count("items"), batches: f.count("import_batches") };
    const preview = await f.preview(admin, sample());
    assert.equal(preview.json().summary.unavailable, 1);
    assert.equal(preview.json().summary.practiceCount, 0);
    const result = await f.commit(admin, preview.json().previewId);
    assert.equal(result.statusCode, 422, result.body);
    assert.deepEqual({ categories: f.count("categories"), items: f.count("items"), batches: f.count("import_batches") }, before);
    const invalid = await f.preview(admin, "## Empty\n\n| 英文 | 中文释义 |\n| --- | --- |\n| Good morning. | |");
    assert.ok(invalid.json().errors.length);
    assert.equal((await f.commit(admin, invalid.json().previewId)).statusCode, 422);
    assert.equal(f.count("categories"), before.categories);
  } finally { await f.close(); }
});

test("category, publication, revision, duplicate insert, and competing preview races cause whole-batch conflict", async () => {
  const f = await fixture();
  try {
    const admin = f.client();
    const category = f.category();
    const oldId = f.item(category);
    const source = sample() + "\n| A completely new phrase. | 新题 | 新谐音 |";
    for (const sql of [
      "UPDATE items SET revision = revision + 1 WHERE id = ?",
      "UPDATE items SET status = 'archived' WHERE id = ?"
    ]) {
      const preview = await f.preview(admin, source);
      f.db.prepare(sql).run(oldId);
      const count = f.count("items");
      const result = await f.commit(admin, preview.json().previewId);
      assert.equal(result.statusCode, 409, result.body);
      assert.equal(f.count("items"), count);
      f.db.prepare("UPDATE items SET status = 'published' WHERE id = ?").run(oldId);
    }
    const categoryPreview = await f.preview(admin, source);
    f.db.prepare("UPDATE categories SET name = 'changed' WHERE id = ?").run(category);
    assert.equal((await f.commit(admin, categoryPreview.json().previewId)).statusCode, 409);
    f.db.prepare("UPDATE categories SET name = '街头摄影' WHERE id = ?").run(category);
    const insertPreview = await f.preview(admin, sample("街头摄影", "Brand new."));
    f.item(category, "Brand new.");
    assert.equal((await f.commit(admin, insertPreview.json().previewId)).statusCode, 409);
    const one = await f.preview(admin, sample("New category"));
    const two = await f.preview(admin, sample("New category"));
    assert.equal((await f.commit(admin, one.json().previewId)).statusCode, 200);
    assert.equal((await f.commit(admin, two.json().previewId)).statusCode, 409);
    assert.equal(f.count("import_batches"), 1);
  } finally { await f.close(); }
});

test("expired previews, cross-owner previews, ordinary users, wrong formats, missing CSRF and foreign origins are rejected", async () => {
  const f = await fixture();
  try {
    const admin = f.client();
    const otherAdmin = f.client();
    const user = f.client("user");
    const preview = await f.preview(admin, sample());
    const id = preview.json().previewId;
    assert.equal((await f.preview(user, sample())).statusCode, 403);
    assert.equal((await f.commit(user, id)).statusCode, 403);
    assert.equal((await f.commit(otherAdmin, id)).statusCode, 404);
    assert.equal((await f.app.inject({ method: "POST", url: "/api/admin/markdown-imports/preview", headers: { cookie: admin.cookie, origin: ORIGIN }, payload: { markdown: sample() } })).statusCode, 403);
    assert.equal((await f.app.inject({ method: "POST", url: "/api/admin/markdown-imports/preview", headers: { ...f.headers(admin), origin: "https://foreign.test" }, payload: { markdown: sample() } })).statusCode, 403);
    assert.equal((await f.post(admin, "/api/admin/imports/commit", { previewId: id })).json().error.code, "IMPORT_FORMAT_MISMATCH");
    const category = f.category();
    const csv = await f.post(admin, "/api/admin/imports/preview", { csv: "english,meaning\nHello,你好", categoryId: category });
    assert.equal((await f.commit(admin, csv.json().previewId)).json().error.code, "IMPORT_FORMAT_MISMATCH");
    f.db.prepare("UPDATE import_previews SET expires_at = 0 WHERE id = ?").run(id);
    assert.equal((await f.commit(admin, id)).json().error.code, "IMPORT_EXPIRED");
    assert.equal(f.count("import_batches"), 0);
  } finally { await f.close(); }
});

test("body limits, field lengths, invalid mappings and sort overflow fail without writes", async () => {
  const f = await fixture();
  try {
    const admin = f.client();
    const user = f.client("user");
    assert.equal((await f.preview(admin, "中".repeat(350_000))).statusCode, 422);
    assert.equal((await f.preview(user, "x".repeat(2_200_000))).statusCode, 403);
    assert.equal((await f.preview(admin, sample(), { mappings: [{ groupId: "not-found", kind: "word" }] })).statusCode, 422);
    const long = await f.preview(admin, sample("New", "a".repeat(501)));
    assert.ok(long.json().errors.length);
    const category = f.category();
    const old = f.item(category, "old");
    f.db.prepare("UPDATE items SET sort_order = 1000000 WHERE id = ?").run(old);
    const full = await f.preview(admin, sample());
    assert.ok(full.json().errors.some((error: { field?: string }) => error.field === "sortOrder"));
    assert.equal((await f.commit(admin, full.json().previewId)).statusCode, 422);
  } finally { await f.close(); }
});

test("batch reads and session creation are owner-only and cannot fall back to full content", async () => {
  const f = await fixture();
  try {
    const admin = f.client();
    const other = f.client();
    const preview = await f.preview(admin, sample());
    const result = await f.commit(admin, preview.json().previewId);
    const id = result.json().batchId;
    assert.equal((await f.get(other, `/api/practice/import-batches/${id}`)).statusCode, 404);
    assert.equal((await f.post(other, "/api/practice/sessions", { mode: "sequential", importBatchId: id })).statusCode, 404);
    const loaded = await f.get(admin, `/api/practice/import-batches/${id}`);
    assert.equal((await f.post(admin, "/api/practice/sessions", { mode: "sequential", importBatchId: id, categoryId: loaded.json().items[0].categoryId })).statusCode, 422);
    for (const mode of ["sequential", "random", "mistakes"]) {
      const session = await f.post(admin, "/api/practice/sessions", { mode, importBatchId: id });
      assert.equal(session.statusCode, 200, session.body);
      assert.equal((f.db.prepare("SELECT import_batch_id FROM practice_sessions WHERE id = ?").get(session.json().session.id) as { import_batch_id: string }).import_batch_id, id);
    }
    f.db.prepare("UPDATE items SET status = 'archived' WHERE id = ?").run(loaded.json().items[0].id);
    const empty = await f.get(admin, `/api/practice/import-batches/${id}`);
    assert.deepEqual(empty.json().items, []);
    assert.equal(empty.json().unavailableCount, 1);
    assert.equal((await f.post(admin, "/api/practice/sessions", { mode: "sequential", importBatchId: id })).json().error.code, "IMPORT_BATCH_EMPTY");
    assert.equal((await f.get(admin, "/api/practice/import-batches/missing")).statusCode, 404);
  } finally { await f.close(); }
});

test("batch attempts enforce membership, publication and revision, preserve idempotent retries and regular progress", async () => {
  const f = await fixture();
  try {
    const admin = f.client();
    const preview = await f.preview(admin, sample());
    const imported = await f.commit(admin, preview.json().previewId);
    const batch = (await f.get(admin, `/api/practice/import-batches/${imported.json().batchId}`)).json();
    const item = batch.items[0];
    const outside = (await f.get(admin, "/api/content")).json().items.find((value: { id: string }) => value.id !== item.id);
    const session = await f.post(admin, "/api/practice/sessions", { mode: "sequential", importBatchId: batch.batch.id });
    const url = `/api/practice/sessions/${session.json().session.id}/attempts`;
    const payload = { clientAttemptId: randomUUID(), itemId: item.id, itemRevision: item.revision, answer: item.english, durationMs: 100 };
    assert.equal((await f.post(admin, url, { ...payload, itemId: outside.id, itemRevision: outside.revision })).json().error.code, "ITEM_OUTSIDE_SESSION");
    const accepted = await f.post(admin, url, payload);
    assert.equal(accepted.statusCode, 200, accepted.body);
    assert.equal((await f.post(admin, url, payload)).statusCode, 200);
    assert.equal(f.count("attempts"), 1);
    assert.equal((await f.get(admin, "/api/me/summary")).json().totals.attempts, 1);
    f.db.prepare("UPDATE items SET revision = revision + 1 WHERE id = ?").run(item.id);
    assert.equal((await f.post(admin, url, { ...payload, clientAttemptId: randomUUID() })).json().error.code, "CONTENT_CHANGED");
    f.db.prepare("UPDATE categories SET status = 'draft' WHERE id = ?").run(item.categoryId);
    assert.equal((await f.post(admin, url, { ...payload, clientAttemptId: randomUUID(), itemRevision: item.revision + 1 })).json().error.code, "CONTENT_UNAVAILABLE");
    assert.equal((await f.get(admin, `/api/practice/import-batches/${batch.batch.id}`)).json().items.length, 0);
  } finally { await f.close(); }
});

test("new items append without reordering original items and invalid multi-group inputs roll back as a whole", async () => {
  const f = await fixture();
  try {
    const admin = f.client();
    const category = f.category();
    const id = f.item(category, "old");
    const before = f.count("items");
    const bad = await f.preview(admin, sample("New group") + "\n\n## Broken\n\n| 英文 | 中文释义 |\n| --- | --- |\n| Missing meaning | | ");
    assert.ok(bad.json().errors.length);
    assert.equal((await f.commit(admin, bad.json().previewId)).statusCode, 422);
    assert.equal(f.count("items"), before);
    assert.equal(f.db.prepare("SELECT 1 FROM categories WHERE name = '句型：New group'").get(), undefined);
    const good = await f.preview(admin, sample());
    const result = await f.commit(admin, good.json().previewId);
    assert.equal(result.statusCode, 200, result.body);
    assert.equal((f.db.prepare("SELECT sort_order FROM items WHERE id = ?").get(id) as { sort_order: number }).sort_order, 900);
    assert.equal((f.db.prepare("SELECT MAX(sort_order) AS n FROM items WHERE category_id = ?").get(category) as { n: number }).n, 901);
  } finally { await f.close(); }
});

test("schema 4 upgrades an actual schema 3 without touching legacy rows and a pre-upgrade backup restores cleanly", async () => {
  const folder = mkdtempSync(join(tmpdir(), "etp-md-migration-"));
  const db = openDatabase({ databasePath: join(folder, "app.db") });
  let restored: ReturnType<typeof openDatabase> | undefined;
  try {
    const source = readFileSync(resolve(import.meta.dirname, "../src/database.ts"), "utf8");
    const migrations = [...source.matchAll(/version:\s*(\d+),\s*sql:\s*`([\s\S]*?)`/g)].filter((match) => Number(match[1]) <= 3);
    assert.equal(migrations.length, 3);
    db.exec("CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, checksum TEXT NOT NULL, applied_at INTEGER NOT NULL) STRICT");
    for (const match of migrations) {
      db.exec(match[2]!);
      db.prepare("INSERT INTO schema_migrations VALUES (?, ?, 1)").run(Number(match[1]), createHash("sha256").update(match[2]!.replace(/\r\n/g, "\n").trim()).digest("hex"));
    }
    db.prepare(`INSERT INTO users(id,username,display_name,password_hash,role,created_at,updated_at) VALUES ('legacy','legacy','Legacy','secret-hash','admin',1,1)`).run();
    db.prepare(`INSERT INTO import_previews(id,created_by,payload_json,errors_json,row_count,created_at,expires_at) VALUES ('old-csv','legacy','[]','[]',0,1,9999999999999)`).run();
    db.prepare(`INSERT INTO practice_sessions(id,user_id,mode,started_at) VALUES ('old-session','legacy','sequential',1)`).run();
    const before = db.prepare("SELECT * FROM users").all();
    const historicalChecksums = db.prepare("SELECT * FROM schema_migrations").all();
    await db.backup(join(folder, "before.db"));
    assert.equal(migrateDatabase(db), 4);
    assert.equal(migrateDatabase(db), 4);
    assert.deepEqual(db.prepare("SELECT * FROM users").all(), before);
    assert.deepEqual(db.prepare("SELECT * FROM schema_migrations WHERE version <= 3").all(), historicalChecksums);
    assert.equal((db.prepare("SELECT format FROM import_previews WHERE id = 'old-csv'").get() as { format: string }).format, "csv");
    assert.equal((db.prepare("SELECT import_batch_id FROM practice_sessions WHERE id = 'old-session'").get() as { import_batch_id: string | null }).import_batch_id, null);
    assert.deepEqual(db.pragma("foreign_key_check"), []);
    restored = openDatabase({ databasePath: join(folder, "before.db") });
    assert.equal((restored.prepare("SELECT MAX(version) AS v FROM schema_migrations").get() as { v: number }).v, 3);
    assert.deepEqual(restored.prepare("SELECT * FROM users").all(), before);
    assert.equal(restored.prepare("SELECT 1 FROM sqlite_master WHERE name = 'import_batches'").get(), undefined);
    assert.deepEqual(restored.pragma("integrity_check"), [{ integrity_check: "ok" }]);
  } finally { restored?.close(); db.close(); rmSync(folder, { recursive: true, force: true }); }
});

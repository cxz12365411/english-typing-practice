import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import type { FastifyReply, FastifyRequest } from "fastify";
import { buildApp } from "../src/app.js";
import { createSession, type UserRow } from "../src/auth.js";
import { parseSentenceMarkdown } from "../src/content-parser.js";
import { openDatabase, type SqliteDatabase } from "../src/database.js";
import { normalizeMarkdownCategoryTitle, parseMarkdownImport } from "../src/markdown-import-parser.js";
import { normalizeAnswer } from "../src/security.js";

import { migratePreCet4Fixture } from "./historical-content-fixture.js";

const SOURCE = resolve(import.meta.dirname, "../..");
const EXTRA_FILE = "docs/bar-social-extra-32.md";
const ORIGIN = "https://english.test";
// Captured from the approved b056d696 corpus, not regenerated from the new source.
const ORIGINAL_ITEMS_SHA256 = "a1290e48906efa9e005ed1093bcc6c14991c2cd66e4874e2540f86b4f7a0a2d5";
const ORIGINAL_CATEGORIES_SHA256 = "4bc4d3de9bba4458ab3c2af39c61a30935a8a01c6fad5ed0b5bb424a4f9b5d88";
const EXPECTED_ENGLISH = [
  "Hey, is this seat taken?", "Mind if I join you?", "Are you having a good night?",
  "I had to come over and say hi.", "You have a lovely smile.", "I like your earrings.",
  "You look really nice tonight.", "Have you been here before?",
  "What are you drinking?", "What's your favorite cocktail?", "Can I buy you a drink?",
  "Would you prefer something non-alcoholic?", "I'll have a beer, please.",
  "Could we have two glasses of water?", "Cheers! It's nice to meet you.", "I'm taking it easy tonight.",
  "What brings you out tonight?", "Do you live around here?", "What kind of music are you into?",
  "I love this song.", "You've got a great sense of humor.", "I'm enjoying talking to you.",
  "Would you like to dance?", "Want to grab coffee sometime?",
  "Would you like to exchange numbers?", "Can I add you on WeChat?", "Can I follow you on Instagram?",
  "Can I text you tomorrow?", "I'd love to see you again.", "No problem. Enjoy your night!",
  "I'll let you get back to your friends.", "Get home safe!"
] as const;
const EXPECTED_CATEGORIES = [
  "句型：酒吧社交：开场与轻松夸赞", "句型：酒吧社交：点酒与碰杯",
  "句型：酒吧社交：闲聊与邀请", "句型：酒吧社交：交换联系方式与礼貌结束"
] as const;

function corpus() {
  return parseSentenceMarkdown(readFileSync(resolve(SOURCE, "daily-english-high-frequency-sentences.md"), "utf8"));
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function count(db: SqliteDatabase, table: string): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}

function snapshot(db: SqliteDatabase): string {
  const tables = ["schema_migrations", "app_meta", "categories", "items", "item_revisions", "users", "sessions",
    "practice_sessions", "attempts", "progress", "audit_log", "import_previews", "import_batches", "import_batch_items"];
  return JSON.stringify(tables.map((table) => [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
}

function original238Database(): SqliteDatabase {
  const db = openDatabase({ databasePath: ":memory:" });
  migratePreCet4Fixture(db, SOURCE);
  db.prepare("DELETE FROM item_revisions WHERE item_id IN (SELECT id FROM items WHERE item_key BETWEEN 'sentence-0239' AND 'sentence-0270')").run();
  db.prepare("DELETE FROM items WHERE item_key BETWEEN 'sentence-0239' AND 'sentence-0270'").run();
  db.prepare("DELETE FROM categories WHERE slug IN ('sentences-19', 'sentences-20', 'sentences-21', 'sentences-22')").run();
  return db;
}

test("bar source additions preserve all original 238 identities, text, pronunciation and order", () => {
  const parsed = corpus();
  const original = parsed.items.filter((item) => Number(item.key.slice(9)) <= 238);
  assert.equal(original.length, 238);
  assert.equal(digest(original), ORIGINAL_ITEMS_SHA256);
  assert.equal(digest(parsed.categories.slice(0, 18)), ORIGINAL_CATEGORIES_SHA256);
  assert.deepEqual(original.map((item) => item.key).sort(),
    Array.from({ length: 238 }, (_, index) => `sentence-${String(index + 1).padStart(4, "0")}`));
  const streetCategories = new Set(parsed.categories.slice(14, 18).map((category) => category.slug));
  assert.equal(original.filter((item) => streetCategories.has(item.categorySlug)).length, 70);
});

test("canonical 32 bar phrases exactly match the approved plan and the four-group Markdown import", () => {
  const parsed = corpus();
  const extra = parseMarkdownImport(readFileSync(resolve(SOURCE, EXTRA_FILE), "utf8"));
  const added = parsed.items.filter((item) => Number(item.key.slice(9)) >= 239);
  assert.deepEqual(extra.errors, []);
  assert.deepEqual(extra.warnings, []);
  assert.equal(extra.groups.length, 4);
  assert.equal(extra.rows.length, 32);
  assert.equal(parsed.items.length, 270);
  assert.equal(parsed.categories.length, 22);
  assert.deepEqual(added.map((item) => item.english), EXPECTED_ENGLISH);
  assert.deepEqual(added.map((item) => item.key),
    Array.from({ length: 32 }, (_, index) => `sentence-${String(index + 239).padStart(4, "0")}`));
  assert.deepEqual(parsed.categories.slice(18).map((category) => category.name), EXPECTED_CATEGORIES);
  for (const [index, group] of extra.groups.entries()) {
    const category = parsed.categories[index + 18]!;
    const sourceRows = extra.rows.filter((row) => row.groupId === group.groupId);
    const categoryAdditions = added.filter((item) => item.categorySlug === category.slug);
    assert.equal(group.kind, "sentence");
    assert.equal(normalizeMarkdownCategoryTitle(group.title), normalizeMarkdownCategoryTitle(category.name));
    assert.equal(sourceRows.length, 8);
    assert.deepEqual(categoryAdditions.map(({ english, meaning, pronunciation }) => ({ english, meaning, pronunciation })),
      sourceRows.map(({ english, meaning, pronunciation }) => ({ english, meaning, pronunciation })));
    assert.deepEqual(categoryAdditions.map((item) => item.sortOrder), [1, 2, 3, 4, 5, 6, 7, 8]);
  }
  assert.ok(added.every((item) => item.meaning.trim() && item.pronunciation.trim()));
  const existingAnswers = new Set(parsed.items.filter((item) => Number(item.key.slice(9)) <= 238)
    .map((item) => normalizeAnswer(item.english)));
  assert.ok(added.every((item) => !existingAnswers.has(normalizeAnswer(item.english))));
  assert.equal(new Set(added.map((item) => normalizeAnswer(item.english))).size, 32);
});

test("fresh 270-sentence installations publish 26 categories once without any new migration or content patch", () => {
  const db = openDatabase({ databasePath: ":memory:" });
  try {
    assert.deepEqual(migratePreCet4Fixture(db, SOURCE), { categoriesInserted: 26, itemsInserted: 1120, words: 850, sentences: 270 });
    assert.equal(count(db, "categories WHERE status = 'published'"), 26);
    assert.equal(count(db, "items WHERE status = 'published'"), 1120);
    assert.equal(count(db, "item_revisions"), 1120);
    assert.equal(count(db, "schema_migrations"), 4);
    const before = snapshot(db);
    assert.deepEqual(migratePreCet4Fixture(db, "Z:\\missing-source-directory"), { categoriesInserted: 0, itemsInserted: 0, words: 850, sentences: 270 });
    assert.equal(snapshot(db), before);
    assert.equal(count(db, "app_meta WHERE key LIKE 'content_update:street-photography-%'"), 2);
  } finally { db.close(); }
});

test("existing 238-sentence databases never automatically import bar phrases on startup", () => {
  const db = original238Database();
  try {
    const before = snapshot(db);
    for (const source of [SOURCE, "Z:\\missing-source-directory"]) {
      assert.deepEqual(migratePreCet4Fixture(db, source), { categoriesInserted: 0, itemsInserted: 0, words: 850, sentences: 238 });
      assert.equal(snapshot(db), before);
    }
    assert.equal(count(db, "categories"), 22);
    assert.equal(count(db, "items"), 1088);
    assert.equal(count(db, "app_meta WHERE key LIKE 'content_update:street-photography-%'"), 2);
  } finally { db.close(); }
});

test("legacy 238-sentence databases without an initial seed marker remain unchanged instead of getting 32 bar items", () => {
  const db = original238Database();
  try {
    const items = db.prepare("SELECT * FROM items ORDER BY id").all();
    const categories = db.prepare("SELECT * FROM categories ORDER BY id").all();
    const revisions = db.prepare("SELECT * FROM item_revisions ORDER BY id").all();
    db.prepare("DELETE FROM app_meta WHERE key IN ('initial_seed_completed', 'initial_seed_checksum')").run();
    assert.deepEqual(migratePreCet4Fixture(db, SOURCE), { categoriesInserted: 0, itemsInserted: 0, words: 850, sentences: 238 });
    assert.deepEqual(db.prepare("SELECT * FROM items ORDER BY id").all(), items);
    assert.deepEqual(db.prepare("SELECT * FROM categories ORDER BY id").all(), categories);
    assert.deepEqual(db.prepare("SELECT * FROM item_revisions ORDER BY id").all(), revisions);
    assert.deepEqual(db.prepare("SELECT value FROM app_meta WHERE key = 'initial_seed_checksum'").get(), { value: "legacy-v1" });
  } finally { db.close(); }
});

test("MD-imported bar categories and phrases preserve original IDs and history across restart, retry and repeated upload", async () => {
  const db = original238Database();
  const app = await buildApp({ database: db, logger: false, config: {
    databasePath: ":memory:", appOrigin: ORIGIN, contentSourceDir: SOURCE,
    guestTokenSecret: "test-guest-token-secret-at-least-32-bytes"
  } });
  try {
    const now = Date.now();
    db.prepare(`INSERT INTO users(id, username, display_name, password_hash, role, active, must_change_password, created_at, updated_at)
      VALUES ('bar-admin', 'bar-admin', 'Bar import test', 'unused-test-only-hash', 'admin', 1, 0, ?, ?)`).run(now, now);
    const oldItem = db.prepare("SELECT id FROM items WHERE item_key = 'sentence-0001'").get() as { id: string };
    db.prepare("UPDATE items SET meaning = '管理员原有释义', pronunciation = '管理员原有谐音', revision = 2 WHERE id = ?").run(oldItem.id);
    db.prepare("INSERT INTO item_revisions(item_id, revision, action, snapshot_json, created_at) VALUES (?, 2, 'edit', '{}', ?)").run(oldItem.id, now);
    db.prepare("INSERT INTO practice_sessions(id, user_id, mode, started_at, finished_at) VALUES ('bar-history-session', 'bar-admin', 'sequential', ?, ?)").run(now - 1000, now);
    db.prepare(`INSERT INTO attempts(id, client_attempt_id, practice_session_id, user_id, item_id, correct, first_try_correct, occurred_at, created_at, item_revision)
      VALUES ('bar-history-attempt', 'bar-history-client', 'bar-history-session', 'bar-admin', ?, 0, 0, ?, ?, 2)`).run(oldItem.id, now, now);
    db.prepare("INSERT INTO progress(user_id, item_id, attempt_count, wrong_count, is_mistake, updated_at) VALUES ('bar-admin', ?, 1, 1, 1, ?)").run(oldItem.id, now);
    const user = db.prepare("SELECT * FROM users WHERE id = 'bar-admin'").get() as UserRow;
    let cookie = "";
    const reply = { setCookie(name: string, value: string) { cookie = `${name}=${value}`; } } as unknown as FastifyReply;
    const session = createSession(db, reply, { ip: "127.0.0.1", headers: {} } as FastifyRequest, user);
    const headers = { cookie, origin: ORIGIN, "x-csrf-token": session.csrfToken };
    const oldItems = db.prepare("SELECT * FROM items ORDER BY id").all();
    const oldCategories = db.prepare("SELECT * FROM categories ORDER BY id").all();
    const oldRevisions = db.prepare("SELECT * FROM item_revisions ORDER BY id").all();
    const historyTables = ["users", "practice_sessions", "attempts", "progress"];
    const history = historyTables.map((table) => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());
    const beforeVersion = db.prepare("SELECT value FROM app_meta WHERE key = 'content_version'").get() as { value: string };
    const payload = { markdown: readFileSync(resolve(SOURCE, EXTRA_FILE), "utf8"), fileName: "bar-social-extra-32.md" };
    const preview = await app.inject({ method: "POST", url: "/api/admin/markdown-imports/preview", headers, payload });
    assert.equal(preview.statusCode, 200, preview.body);
    assert.deepEqual(preview.json().errors, []);
    assert.equal(preview.json().summary.created, 32);
    assert.equal(preview.json().summary.reused, 0);
    assert.equal(preview.json().summary.practiceCount, 32);
    assert.equal(preview.json().groups.length, 4);
    assert.ok(preview.json().groups.every((group: { action: string }) => group.action === "create"));
    const commitPayload = { previewId: preview.json().previewId };
    const commit = await app.inject({ method: "POST", url: "/api/admin/markdown-imports/commit", headers, payload: commitPayload });
    assert.equal(commit.statusCode, 200, commit.body);
    assert.equal(commit.json().created, 32);
    assert.equal(commit.json().reused, 0);
    assert.equal(commit.json().practiceCount, 32);
    assert.equal(count(db, "categories"), 26);
    assert.equal(count(db, "items"), 1120);
    const createdCategories = db.prepare("SELECT name, kind, status FROM categories WHERE slug LIKE 'md-%' ORDER BY sort_order").all() as
      Array<{ name: string; kind: string; status: string }>;
    assert.equal(createdCategories.length, 4);
    assert.ok(createdCategories.every((category) => category.kind === "sentence" && category.status === "published"));
    assert.deepEqual(createdCategories.map((category) => normalizeMarkdownCategoryTitle(category.name)),
      EXPECTED_CATEGORIES.map(normalizeMarkdownCategoryTitle));
    assert.equal(count(db, "items WHERE item_key LIKE 'md-%' AND status = 'published'"), 32);
    assert.equal(count(db, "items WHERE item_key BETWEEN 'sentence-0239' AND 'sentence-0270'"), 0);
    assert.deepEqual(db.prepare("SELECT * FROM items WHERE item_key NOT LIKE 'md-%' ORDER BY id").all(), oldItems);
    assert.deepEqual(db.prepare("SELECT * FROM categories WHERE slug NOT LIKE 'md-%' ORDER BY id").all(), oldCategories);
    assert.deepEqual(db.prepare("SELECT * FROM item_revisions WHERE item_id IN (SELECT id FROM items WHERE item_key NOT LIKE 'md-%') ORDER BY id").all(), oldRevisions);
    assert.deepEqual(historyTables.map((table) => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()), history);
    const version = db.prepare("SELECT value FROM app_meta WHERE key = 'content_version'").get() as { value: string };
    assert.equal(Number(version.value), Number(beforeVersion.value) + 1);
    const batch = await app.inject({ method: "GET", url: `/api/practice/import-batches/${commit.json().batchId}`, headers: { cookie } });
    assert.equal(batch.statusCode, 200, batch.body);
    assert.deepEqual(batch.json().items.map((item: { english: string }) => item.english), EXPECTED_ENGLISH);
    const importedItems = db.prepare("SELECT * FROM items WHERE item_key LIKE 'md-%' ORDER BY id").all();
    const beforeRestart = snapshot(db);
    assert.deepEqual(migratePreCet4Fixture(db, SOURCE), { categoriesInserted: 0, itemsInserted: 0, words: 850, sentences: 270 });
    assert.equal(snapshot(db), beforeRestart);
    const retry = await app.inject({ method: "POST", url: "/api/admin/markdown-imports/commit", headers, payload: commitPayload });
    assert.equal(retry.statusCode, 200, retry.body);
    assert.deepEqual(retry.json(), commit.json());
    assert.equal(count(db, "import_batches"), 1);
    const repeatedPreview = await app.inject({ method: "POST", url: "/api/admin/markdown-imports/preview", headers, payload });
    assert.equal(repeatedPreview.statusCode, 200, repeatedPreview.body);
    assert.equal(repeatedPreview.json().summary.created, 0);
    assert.equal(repeatedPreview.json().summary.reused, 32);
    assert.ok(repeatedPreview.json().groups.every((group: { action: string }) => group.action === "existing"));
    const repeatedCommit = await app.inject({ method: "POST", url: "/api/admin/markdown-imports/commit", headers,
      payload: { previewId: repeatedPreview.json().previewId } });
    assert.equal(repeatedCommit.statusCode, 200, repeatedCommit.body);
    assert.equal(repeatedCommit.json().created, 0);
    assert.equal(repeatedCommit.json().reused, 32);
    assert.equal(count(db, "categories"), 26);
    assert.equal(count(db, "items"), 1120);
    assert.deepEqual(db.prepare("SELECT * FROM items WHERE item_key LIKE 'md-%' ORDER BY id").all(), importedItems);
    assert.deepEqual(db.prepare("SELECT value FROM app_meta WHERE key = 'content_version'").get(), version);
    assert.deepEqual(historyTables.map((table) => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()), history);
  } finally { await app.close(); db.close(); }
});

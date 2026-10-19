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
const EXTRA_FILE = "docs/street-photography-extra-32.md";
const ORIGIN = "https://english.test";
const ORIGINAL_ITEMS_SHA256 = "c3f3b77810a0233820f5b9c02d7853a6880b8a91c10513bbec81d7fb255173e6";
const ORIGINAL_CATEGORIES_SHA256 = "4bc4d3de9bba4458ab3c2af39c61a30935a8a01c6fad5ed0b5bb424a4f9b5d88";

function corpus() {
  return parseSentenceMarkdown(readFileSync(resolve(SOURCE, "daily-english-high-frequency-sentences.md"), "utf8"));
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function snapshot(db: SqliteDatabase): string {
  const tables = ["app_meta", "categories", "items", "item_revisions", "users", "sessions", "practice_sessions",
    "attempts", "progress", "audit_log", "import_previews", "import_batches", "import_batch_items"];
  return JSON.stringify(tables.map((table) => [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
}

function original206Database(): SqliteDatabase {
  const db = openDatabase({ databasePath: ":memory:" });
  migratePreCet4Fixture(db, SOURCE);
  db.prepare("DELETE FROM item_revisions WHERE item_id IN (SELECT id FROM items WHERE item_key BETWEEN 'sentence-0207' AND 'sentence-0270')").run();
  db.prepare("DELETE FROM items WHERE item_key BETWEEN 'sentence-0207' AND 'sentence-0270'").run();
  db.prepare("DELETE FROM categories WHERE slug IN ('sentences-19', 'sentences-20', 'sentences-21', 'sentences-22')").run();
  return db;
}

test("October street source additions preserve all original 206 identities, content and ordering", () => {
  const parsed = corpus();
  const original = parsed.items.filter((item) => Number(item.key.slice(9)) <= 206);
  assert.equal(original.length, 206);
  assert.equal(digest(original), ORIGINAL_ITEMS_SHA256);
  assert.equal(digest(parsed.categories.slice(0, 18)), ORIGINAL_CATEGORIES_SHA256);
  assert.deepEqual(original.map((item) => item.key).sort(),
    Array.from({ length: 206 }, (_, index) => `sentence-${String(index + 1).padStart(4, "0")}`));
});

test("canonical 32 new street phrases exactly match the published Markdown import source", () => {
  const parsed = corpus();
  const extra = parseMarkdownImport(readFileSync(resolve(SOURCE, EXTRA_FILE), "utf8"));
  assert.deepEqual(extra.errors, []);
  assert.deepEqual(extra.warnings, []);
  assert.equal(extra.groups.length, 4);
  assert.equal(extra.rows.length, 32);
  assert.ok(extra.groups.every((group) => group.kind === "sentence"));
  const added = parsed.items.filter((item) => {
    const number = Number(item.key.slice(9));
    return number >= 207 && number <= 238;
  });
  assert.equal(parsed.items.length, 270);
  assert.deepEqual(added.map((item) => item.key),
    Array.from({ length: 32 }, (_, index) => `sentence-${String(index + 207).padStart(4, "0")}`));

  for (const [index, group] of extra.groups.entries()) {
    const category = parsed.categories[index + 14]!;
    assert.equal(normalizeMarkdownCategoryTitle(category.name), normalizeMarkdownCategoryTitle(group.title));
    const sourceRows = extra.rows.filter((row) => row.groupId === group.groupId);
    const categoryAdditions = added.filter((item) => item.categorySlug === category.slug);
    assert.equal(sourceRows.length, 8);
    assert.deepEqual(categoryAdditions.map(({ english, meaning, pronunciation }) => ({ english, meaning, pronunciation })),
      sourceRows.map(({ english, meaning, pronunciation }) => ({ english, meaning, pronunciation })));
    const originalCount = [10, 11, 9, 8][index]!;
    assert.deepEqual(categoryAdditions.map((item) => item.sortOrder),
      Array.from({ length: 8 }, (_, offset) => originalCount + offset + 1));
    assert.equal(parsed.items.filter((item) => item.categorySlug === category.slug).length, originalCount + 8);
  }
  assert.ok(added.every((item) => item.meaning.trim() && item.pronunciation.trim()));
  const uniqueAnswers = new Set(parsed.items.map((item) => `${item.categorySlug}\0${normalizeAnswer(item.english)}`));
  assert.equal(uniqueAnswers.size, parsed.items.length);
});

test("existing 206-item databases never automatically import the 32 fresh-source additions on startup", () => {
  const db = original206Database();
  try {
    const before = snapshot(db);
    for (const source of [SOURCE, "Z:\\missing-source-directory"]) {
      assert.deepEqual(migratePreCet4Fixture(db, source), { categoriesInserted: 0, itemsInserted: 0, words: 850, sentences: 206 });
      assert.equal(snapshot(db), before);
    }
    assert.equal(db.prepare("SELECT value FROM app_meta WHERE key = 'content_update:street-photography-v3'").get(), undefined);
  } finally {
    db.close();
  }
});

test("new 270-item installations seed only once and accept the legacy marker compatibility path", () => {
  const db = openDatabase({ databasePath: ":memory:" });
  try {
    assert.deepEqual(migratePreCet4Fixture(db, SOURCE), { categoriesInserted: 26, itemsInserted: 1120, words: 850, sentences: 270 });
    const before = snapshot(db);
    assert.deepEqual(migratePreCet4Fixture(db, "Z:\\missing-source-directory"), { categoriesInserted: 0, itemsInserted: 0, words: 850, sentences: 270 });
    assert.equal(snapshot(db), before);
    const items = db.prepare("SELECT * FROM items ORDER BY id").all();
    db.prepare("DELETE FROM app_meta WHERE key IN ('initial_seed_completed', 'initial_seed_checksum')").run();
    assert.deepEqual(migratePreCet4Fixture(db, SOURCE), { categoriesInserted: 0, itemsInserted: 0, words: 850, sentences: 270 });
    assert.deepEqual(db.prepare("SELECT * FROM items ORDER BY id").all(), items);
    assert.deepEqual(db.prepare("SELECT value FROM app_meta WHERE key = 'initial_seed_checksum'").get(), { value: "legacy-v1" });
  } finally {
    db.close();
  }
});

test("MD-imported street additions retain actual imported IDs and do not duplicate on restart or retry", async () => {
  const db = original206Database();
  const app = await buildApp({ database: db, logger: false, config: {
    databasePath: ":memory:", appOrigin: ORIGIN, contentSourceDir: SOURCE,
    guestTokenSecret: "test-guest-token-secret-at-least-32-bytes"
  } });
  try {
    const oldItems = db.prepare("SELECT * FROM items ORDER BY id").all();
    const oldRevisions = db.prepare("SELECT * FROM item_revisions ORDER BY id").all();
    const now = Date.now();
    db.prepare(`INSERT INTO users(id, username, display_name, password_hash, role, active, must_change_password, created_at, updated_at)
      VALUES ('street-admin', 'street-admin', 'Street import test', 'unused-test-only-hash', 'admin', 1, 0, ?, ?)`).run(now, now);
    const oldItem = db.prepare("SELECT id FROM items WHERE item_key = 'sentence-0001'").get() as { id: string };
    db.prepare("INSERT INTO practice_sessions(id, user_id, mode, started_at, finished_at) VALUES ('street-session', 'street-admin', 'sequential', ?, ?)").run(now - 1000, now);
    db.prepare(`INSERT INTO attempts(id, client_attempt_id, practice_session_id, user_id, item_id, correct, first_try_correct, occurred_at, created_at, item_revision)
      VALUES ('street-attempt', 'street-client-attempt', 'street-session', 'street-admin', ?, 0, 0, ?, ?, 1)`).run(oldItem.id, now, now);
    db.prepare("INSERT INTO progress(user_id, item_id, attempt_count, wrong_count, is_mistake, updated_at) VALUES ('street-admin', ?, 1, 1, 1, ?)").run(oldItem.id, now);
    const historyTables = ["users", "practice_sessions", "attempts", "progress"];
    const history = historyTables.map((table) => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());

    const user = db.prepare("SELECT * FROM users WHERE id = 'street-admin'").get() as UserRow;
    let cookie = "";
    const reply = { setCookie(name: string, value: string) { cookie = `${name}=${value}`; } } as unknown as FastifyReply;
    const session = createSession(db, reply, { ip: "127.0.0.1", headers: {} } as FastifyRequest, user);
    const headers = { cookie, origin: ORIGIN, "x-csrf-token": session.csrfToken };
    const preview = await app.inject({ method: "POST", url: "/api/admin/markdown-imports/preview", headers,
      payload: { markdown: readFileSync(resolve(SOURCE, EXTRA_FILE), "utf8"), fileName: "street-photography-extra-32.md" } });
    assert.equal(preview.statusCode, 200, preview.body);
    assert.deepEqual(preview.json().errors, []);
    assert.equal(preview.json().summary.created, 32);
    assert.equal(preview.json().summary.reused, 0);
    assert.equal(preview.json().summary.practiceCount, 32);
    assert.ok(preview.json().groups.every((group: { action: string }) => group.action === "existing"));
    const commitPayload = { previewId: preview.json().previewId };
    const commit = await app.inject({ method: "POST", url: "/api/admin/markdown-imports/commit", headers, payload: commitPayload });
    assert.equal(commit.statusCode, 200, commit.body);
    assert.equal(commit.json().created, 32);
    assert.equal(commit.json().practiceCount, 32);
    assert.deepEqual(db.prepare("SELECT * FROM items WHERE item_key NOT LIKE 'md-%' ORDER BY id").all(), oldItems);
    assert.deepEqual(db.prepare("SELECT * FROM item_revisions WHERE item_id IN (SELECT id FROM items WHERE item_key NOT LIKE 'md-%') ORDER BY id").all(), oldRevisions);
    assert.deepEqual(historyTables.map((table) => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()), history);
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM items WHERE item_key BETWEEN 'sentence-0207' AND 'sentence-0238'").get() as { n: number }).n, 0);
    const beforeRestart = snapshot(db);
    assert.deepEqual(migratePreCet4Fixture(db, SOURCE), { categoriesInserted: 0, itemsInserted: 0, words: 850, sentences: 238 });
    assert.equal(snapshot(db), beforeRestart);
    const retry = await app.inject({ method: "POST", url: "/api/admin/markdown-imports/commit", headers, payload: commitPayload });
    assert.equal(retry.statusCode, 200, retry.body);
    assert.deepEqual(retry.json(), commit.json());
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM items").get() as { n: number }).n, 1088);
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM import_batches").get() as { n: number }).n, 1);
  } finally {
    await app.close();
    db.close();
  }
});

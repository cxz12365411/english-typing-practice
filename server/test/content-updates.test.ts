import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { parseSentenceMarkdown, parseWordMarkdown } from "../src/content-parser.js";
import { applyContentUpdates } from "../src/content-updates.js";
import { bumpContentVersion, migrateAndSeed, migrateDatabase, openDatabase, seedContent, type SqliteDatabase } from "../src/database.js";

const SOURCE = resolve(import.meta.dirname, "../..");
const MARKER = "content_update:street-photography-v1";
const EXPANSION_MARKER = "content_update:street-photography-v2";

function scalar(db: SqliteDatabase, sql: string): number {
  return Object.values(db.prepare(sql).get() as Record<string, number>)[0]!;
}

function snapshot(db: SqliteDatabase): string {
  const tables = ["app_meta", "users", "sessions", "categories", "items", "item_revisions", "practice_sessions", "attempts", "progress", "audit_log"];
  return JSON.stringify(tables.map((table) => [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
}

function legacyDatabase(): SqliteDatabase {
  const db = openDatabase({ databasePath: ":memory:" });
  migrateDatabase(db);
  // Recreate the exact 850/168 seed shape without relying on a second fixture copy of the Markdown.
  seedContent(db, SOURCE);
  db.prepare("DELETE FROM item_revisions WHERE item_id IN (SELECT id FROM items WHERE item_key BETWEEN 'sentence-0169' AND 'sentence-0206')").run();
  db.prepare("DELETE FROM items WHERE item_key BETWEEN 'sentence-0169' AND 'sentence-0206'").run();
  db.prepare("DELETE FROM categories WHERE slug IN ('sentences-15', 'sentences-16', 'sentences-17', 'sentences-18')").run();
  db.prepare("UPDATE app_meta SET value = '7' WHERE key = 'content_version'").run();
  return db;
}

function streetV1Database(): SqliteDatabase {
  const db = openDatabase({ databasePath: ":memory:" });
  migrateAndSeed(db, SOURCE);
  db.prepare("DELETE FROM item_revisions WHERE item_id IN (SELECT id FROM items WHERE item_key BETWEEN 'sentence-0183' AND 'sentence-0206')").run();
  db.prepare("DELETE FROM items WHERE item_key BETWEEN 'sentence-0183' AND 'sentence-0206'").run();
  db.prepare("DELETE FROM app_meta WHERE key = ?").run(EXPANSION_MARKER);
  db.prepare("DELETE FROM audit_log WHERE action = 'content.update' AND target_id = ?").run(EXPANSION_MARKER);
  db.prepare("UPDATE app_meta SET value = '7' WHERE key = 'content_version'").run();
  return db;
}

test("fresh installation seeds 850 words and 206 sentences and records both content updates only once", () => {
  const db = openDatabase({ databasePath: ":memory:" });
  try {
    assert.deepEqual(migrateAndSeed(db, SOURCE), { categoriesInserted: 22, itemsInserted: 1056, words: 850, sentences: 206 });
    assert.equal(scalar(db, "SELECT COUNT(*) FROM item_revisions"), 1056);
    assert.equal(scalar(db, "SELECT COUNT(*) FROM items WHERE status = 'published'"), 1056);
    assert.equal(scalar(db, "SELECT CAST(value AS INTEGER) FROM app_meta WHERE key = 'content_version'"), 1);
    assert.equal((db.prepare("SELECT value FROM app_meta WHERE key = ?").get(MARKER) as { value: string }).value, "1");
    assert.equal((db.prepare("SELECT value FROM app_meta WHERE key = ?").get(EXPANSION_MARKER) as { value: string }).value, "1");
    const audits = db.prepare("SELECT metadata_json FROM audit_log WHERE action = 'content.update' ORDER BY id").all() as Array<{ metadata_json: string }>;
    assert.deepEqual(audits.map((audit) => JSON.parse(audit.metadata_json)), [
      { source: "street-photography-english-phrases.md", categories: 4, items: 14, categoriesInserted: 0, itemsInserted: 0 },
      { source: "street-photography-english-phrases.md", categories: 4, items: 24, categoriesInserted: 0, itemsInserted: 0 }
    ]);
    const before = snapshot(db);
    assert.deepEqual(migrateAndSeed(db, "Z:\\missing-source-directory"), { categoriesInserted: 0, itemsInserted: 0, words: 850, sentences: 206 });
    assert.equal(snapshot(db), before);
  } finally {
    db.close();
  }
});

test("upgrading an original corpus appends both street patches and preserves edited items and learning history", () => {
  const db = legacyDatabase();
  try {
    const now = Date.now();
    const originalItem = db.prepare("SELECT id FROM items WHERE item_key = 'sentence-0001'").get() as { id: string };
    db.prepare("UPDATE items SET english = 'Administrator custom phrase.', normalized_answer = 'administrator custom phrase.', revision = 2, status = 'draft', updated_at = ? WHERE id = ?").run(now, originalItem.id);
    db.prepare("INSERT INTO item_revisions(item_id, revision, action, snapshot_json, created_at) VALUES (?, 2, 'edit', '{}', ?)").run(originalItem.id, now);
    db.prepare("INSERT INTO users(id, username, display_name, password_hash, role, created_at, updated_at) VALUES ('existing-user', 'learner', 'Learner', 'preserved-hash', 'user', ?, ?)").run(now, now);
    db.prepare("INSERT INTO sessions(id_hash, csrf_token, csrf_hash, user_id, created_at, last_seen_at, expires_at, absolute_expires_at, auth_version) VALUES ('existing-session', 'csrf', 'hash', 'existing-user', ?, ?, ?, ?, 1)").run(now, now, now + 10000, now + 10000);
    db.prepare("INSERT INTO practice_sessions(id, user_id, mode, started_at) VALUES ('existing-practice', 'existing-user', 'sequential', ?)").run(now);
    db.prepare("INSERT INTO attempts(id, client_attempt_id, practice_session_id, user_id, item_id, correct, first_try_correct, occurred_at, created_at, item_revision) VALUES ('existing-attempt', 'client-attempt', 'existing-practice', 'existing-user', ?, 0, 0, ?, ?, 1)").run(originalItem.id, now, now);
    db.prepare("INSERT INTO progress(user_id, item_id, attempt_count, wrong_count, is_mistake, updated_at) VALUES ('existing-user', ?, 1, 1, 1, ?)").run(originalItem.id, now);
    const originalRows = db.prepare("SELECT * FROM items ORDER BY item_key").all();
    const categories = db.prepare("SELECT * FROM categories ORDER BY slug").all();
    const historyTables = ["users", "sessions", "practice_sessions", "attempts", "progress"];
    const history = historyTables.map((table) => db.prepare(`SELECT * FROM ${table}`).all());
    const checksum = db.prepare("SELECT value FROM app_meta WHERE key = 'initial_seed_checksum'").get();

    assert.deepEqual(migrateAndSeed(db, SOURCE), { categoriesInserted: 4, itemsInserted: 38, words: 850, sentences: 206 });
    assert.deepEqual(db.prepare("SELECT * FROM items WHERE item_key NOT BETWEEN 'sentence-0169' AND 'sentence-0206' ORDER BY item_key").all(), originalRows);
    assert.deepEqual(db.prepare("SELECT * FROM categories WHERE slug NOT IN ('sentences-15', 'sentences-16', 'sentences-17', 'sentences-18') ORDER BY slug").all(), categories);
    assert.deepEqual(historyTables.map((table) => db.prepare(`SELECT * FROM ${table}`).all()), history);
    assert.deepEqual(db.prepare("SELECT value FROM app_meta WHERE key = 'initial_seed_checksum'").get(), checksum);
    assert.equal(scalar(db, "SELECT CAST(value AS INTEGER) FROM app_meta WHERE key = 'content_version'"), 9);
    assert.equal(scalar(db, "SELECT COUNT(*) FROM item_revisions WHERE action = 'content_update'"), 38);
    assert.equal(scalar(db, "SELECT COUNT(*) FROM items WHERE item_key BETWEEN 'sentence-0169' AND 'sentence-0206' AND status = 'published'"), 38);
  } finally {
    db.close();
  }
});

test("completed content updates do not resurrect archived phrases or overwrite later administrator changes", () => {
  const db = legacyDatabase();
  try {
    migrateAndSeed(db, SOURCE);
    db.prepare("UPDATE items SET status = 'archived', archived_at = ?, english = 'Administrator archived edit.', revision = 2 WHERE item_key = 'sentence-0169'").run(Date.now());
    db.prepare("UPDATE categories SET status = 'draft', name = 'Administrator renamed category' WHERE slug = 'sentences-16'").run();
    const before = snapshot(db);
    assert.deepEqual(migrateAndSeed(db, "Z:\\missing-source-directory"), { categoriesInserted: 0, itemsInserted: 0, words: 850, sentences: 206 });
    assert.equal(snapshot(db), before);
  } finally {
    db.close();
  }
});

test("a late item-key collision rolls back every appended category, item, revision, audit and version", () => {
  const db = legacyDatabase();
  try {
    const category = db.prepare("SELECT id FROM categories WHERE slug = 'sentences-1'").get() as { id: string };
    const now = Date.now();
    db.prepare(`INSERT INTO items(id, item_key, category_id, kind, english, meaning, normalized_answer, created_at, updated_at)
      VALUES ('admin-existing-item', 'sentence-0182', ?, 'sentence', 'Private administrator draft.', '管理员草稿', 'private administrator draft.', ?, ?)`)
      .run(category.id, now, now);
    const before = snapshot(db);
    assert.throws(() => migrateAndSeed(db, SOURCE), /update conflict: item sentence-0182/);
    assert.equal(snapshot(db), before);
    assert.equal(db.prepare("SELECT value FROM app_meta WHERE key = ?").get(MARKER), undefined);
  } finally {
    db.close();
  }
});

test("a category-slug collision is not overwritten and the entire update is rolled back", () => {
  const db = legacyDatabase();
  try {
    const now = Date.now();
    db.prepare("INSERT INTO categories(id, slug, name, kind, sort_order, created_at, updated_at) VALUES ('admin-category', 'sentences-18', 'Existing custom category', 'sentence', 18, ?, ?)").run(now, now);
    const before = snapshot(db);
    assert.throws(() => migrateAndSeed(db, SOURCE), /update conflict: category sentences-18/);
    assert.equal(snapshot(db), before);
  } finally {
    db.close();
  }
});

test("legacy databases without the one-shot seed marker can still upgrade from the original 168 sentences", () => {
  const db = legacyDatabase();
  try {
    db.prepare("DELETE FROM app_meta WHERE key IN ('initial_seed_completed', 'initial_seed_checksum')").run();
    assert.deepEqual(migrateAndSeed(db, SOURCE), { categoriesInserted: 4, itemsInserted: 38, words: 850, sentences: 206 });
    assert.deepEqual(db.prepare("SELECT value FROM app_meta WHERE key = 'initial_seed_checksum'").get(), { value: "legacy-v1" });
  } finally {
    db.close();
  }
});

test("content update source identity is checked before writing to the existing database", () => {
  const db = legacyDatabase();
  try {
    const words = parseWordMarkdown(readFileSync(resolve(SOURCE, "basic-english-850.md"), "utf8"));
    const sentences = parseSentenceMarkdown(readFileSync(resolve(SOURCE, "daily-english-high-frequency-sentences.md"), "utf8"));
    sentences.items.find((item) => item.key === "sentence-0182")!.english = "A different sentence.";
    const before = snapshot(db);
    assert.throws(() => applyContentUpdates(db,
      () => ({ categories: [...words.categories, ...sentences.categories], items: [...words.items, ...sentences.items] }),
      () => bumpContentVersion(db)), /source integrity check failed for item 182/);
    assert.equal(snapshot(db), before);
  } finally {
    db.close();
  }
});

test("v1 to v2 appends 24 phrases without modifying categories, previous street edits or learning history", () => {
  const db = streetV1Database();
  try {
    const now = Date.now();
    const originalItem = db.prepare("SELECT id FROM items WHERE item_key = 'sentence-0173'").get() as { id: string };
    db.prepare("UPDATE items SET english = 'Keep this administrator edit.', normalized_answer = 'keep this administrator edit.', revision = 2, status = 'archived', archived_at = ?, updated_at = ? WHERE id = ?").run(now, now, originalItem.id);
    db.prepare("INSERT INTO item_revisions(item_id, revision, action, snapshot_json, created_at) VALUES (?, 2, 'edit', '{}', ?)").run(originalItem.id, now);
    db.prepare("INSERT INTO users(id, username, display_name, password_hash, role, created_at, updated_at) VALUES ('v1-user', 'v1-learner', 'Learner', 'preserved-hash', 'user', ?, ?)").run(now, now);
    db.prepare("INSERT INTO sessions(id_hash, csrf_token, csrf_hash, user_id, created_at, last_seen_at, expires_at, absolute_expires_at, auth_version) VALUES ('v1-session', 'csrf', 'hash', 'v1-user', ?, ?, ?, ?, 1)").run(now, now, now + 10000, now + 10000);
    db.prepare("INSERT INTO practice_sessions(id, user_id, mode, started_at) VALUES ('v1-practice', 'v1-user', 'sequential', ?)").run(now);
    db.prepare("INSERT INTO attempts(id, client_attempt_id, practice_session_id, user_id, item_id, correct, first_try_correct, occurred_at, created_at, item_revision) VALUES ('v1-attempt', 'v1-client-attempt', 'v1-practice', 'v1-user', ?, 0, 0, ?, ?, 1)").run(originalItem.id, now, now);
    db.prepare("INSERT INTO progress(user_id, item_id, attempt_count, wrong_count, is_mistake, updated_at) VALUES ('v1-user', ?, 1, 1, 1, ?)").run(originalItem.id, now);
    const originalRows = db.prepare("SELECT * FROM items ORDER BY item_key").all();
    const categories = db.prepare("SELECT * FROM categories ORDER BY slug").all();
    const revisions = db.prepare("SELECT * FROM item_revisions ORDER BY id").all();
    const historyTables = ["users", "sessions", "practice_sessions", "attempts", "progress"];
    const history = historyTables.map((table) => db.prepare(`SELECT * FROM ${table}`).all());
    const originalAudit = db.prepare("SELECT * FROM audit_log WHERE target_id = ?").all(MARKER);
    const checksum = db.prepare("SELECT value FROM app_meta WHERE key = 'initial_seed_checksum'").get();

    assert.deepEqual(migrateAndSeed(db, SOURCE), { categoriesInserted: 0, itemsInserted: 24, words: 850, sentences: 206 });
    assert.deepEqual(db.prepare("SELECT * FROM items WHERE item_key NOT BETWEEN 'sentence-0183' AND 'sentence-0206' ORDER BY item_key").all(), originalRows);
    assert.deepEqual(db.prepare("SELECT * FROM categories ORDER BY slug").all(), categories);
    assert.deepEqual(db.prepare("SELECT * FROM item_revisions WHERE item_id NOT IN (SELECT id FROM items WHERE item_key BETWEEN 'sentence-0183' AND 'sentence-0206') ORDER BY id").all(), revisions);
    assert.deepEqual(historyTables.map((table) => db.prepare(`SELECT * FROM ${table}`).all()), history);
    assert.deepEqual(db.prepare("SELECT * FROM audit_log WHERE target_id = ?").all(MARKER), originalAudit);
    assert.deepEqual(db.prepare("SELECT value FROM app_meta WHERE key = 'initial_seed_checksum'").get(), checksum);
    assert.equal(scalar(db, "SELECT CAST(value AS INTEGER) FROM app_meta WHERE key = 'content_version'"), 8);
    assert.equal(scalar(db, "SELECT COUNT(*) FROM item_revisions WHERE action = 'content_update'"), 24);
    assert.equal(scalar(db, "SELECT COUNT(*) FROM items WHERE item_key BETWEEN 'sentence-0183' AND 'sentence-0206' AND status = 'published'"), 24);
    const audit = db.prepare("SELECT metadata_json FROM audit_log WHERE action = 'content.update' AND target_id = ?").get(EXPANSION_MARKER) as { metadata_json: string };
    assert.deepEqual(JSON.parse(audit.metadata_json), {
      source: "street-photography-english-phrases.md", categories: 4, items: 24, categoriesInserted: 0, itemsInserted: 24
    });
    const after = snapshot(db);
    assert.deepEqual(migrateAndSeed(db, "Z:\\missing-source-directory"), { categoriesInserted: 0, itemsInserted: 0, words: 850, sentences: 206 });
    assert.equal(snapshot(db), after);
  } finally {
    db.close();
  }
});

test("v2 completion does not resurrect archived expansion phrases or revisit edited source/category state", () => {
  const db = streetV1Database();
  try {
    migrateAndSeed(db, SOURCE);
    db.prepare("UPDATE items SET status = 'archived', archived_at = ?, english = 'Archived expansion administrator edit.', revision = 2 WHERE item_key = 'sentence-0206'").run(Date.now());
    db.prepare("UPDATE categories SET status = 'draft', name = 'Renamed after expansion' WHERE slug = 'sentences-18'").run();
    const before = snapshot(db);
    assert.deepEqual(migrateAndSeed(db, "Z:\\missing-source-directory"), { categoriesInserted: 0, itemsInserted: 0, words: 850, sentences: 206 });
    assert.equal(snapshot(db), before);
  } finally {
    db.close();
  }
});

test("a late v2 collision rolls back the whole expansion but preserves the previously completed v1", () => {
  const db = streetV1Database();
  try {
    const category = db.prepare("SELECT id FROM categories WHERE slug = 'sentences-18'").get() as { id: string };
    const now = Date.now();
    db.prepare(`INSERT INTO items(id, item_key, category_id, kind, english, meaning, normalized_answer, created_at, updated_at)
      VALUES ('v2-admin-existing-item', 'sentence-0206', ?, 'sentence', 'Private expansion collision.', '管理员草稿', 'private expansion collision.', ?, ?)`)
      .run(category.id, now, now);
    const before = snapshot(db);
    assert.throws(() => migrateAndSeed(db, SOURCE), /update conflict: item sentence-0206/);
    assert.equal(snapshot(db), before);
    assert.deepEqual(db.prepare("SELECT value FROM app_meta WHERE key = ?").get(MARKER), { value: "1" });
    assert.equal(db.prepare("SELECT value FROM app_meta WHERE key = ?").get(EXPANSION_MARKER), undefined);
  } finally {
    db.close();
  }
});

test("v2 refuses renamed or unpublished existing categories instead of overwriting administrator changes", () => {
  for (const update of ["name = 'Custom category name'", "status = 'draft'", "status = 'archived', archived_at = 1"]) {
    const db = streetV1Database();
    try {
      db.prepare(`UPDATE categories SET ${update} WHERE slug = 'sentences-18'`).run();
      const before = snapshot(db);
      assert.throws(() => migrateAndSeed(db, SOURCE), /update conflict: category sentences-18/);
      assert.equal(snapshot(db), before);
    } finally {
      db.close();
    }
  }
});

test("v2 source identity rejects an altered last phrase without writing any expansion state", () => {
  const db = streetV1Database();
  try {
    const sentences = parseSentenceMarkdown(readFileSync(resolve(SOURCE, "daily-english-high-frequency-sentences.md"), "utf8"));
    sentences.items.find((item) => item.key === "sentence-0206")!.english = "Unexpected expansion source.";
    const before = snapshot(db);
    assert.throws(() => applyContentUpdates(db, () => sentences, () => bumpContentVersion(db)), /expansion source integrity check failed for item 206/);
    assert.equal(snapshot(db), before);
  } finally {
    db.close();
  }
});

test("legacy databases without seed markers accept either v1 or expanded corpus size", () => {
  for (const alreadyExpanded of [false, true]) {
    const db = streetV1Database();
    try {
      if (alreadyExpanded) migrateAndSeed(db, SOURCE);
      db.prepare("DELETE FROM app_meta WHERE key IN ('initial_seed_completed', 'initial_seed_checksum')").run();
      assert.deepEqual(migrateAndSeed(db, SOURCE), {
        categoriesInserted: 0, itemsInserted: alreadyExpanded ? 0 : 24, words: 850, sentences: 206
      });
      assert.deepEqual(db.prepare("SELECT value FROM app_meta WHERE key = 'initial_seed_checksum'").get(), { value: "legacy-v1" });
    } finally {
      db.close();
    }
  }
});

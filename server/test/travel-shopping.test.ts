import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { parseSentenceMarkdown } from "../src/content-parser.js";
import { applyTravelShoppingUpdate, TRAVEL_SHOPPING_UPDATE } from "../src/content-updates.js";
import { bumpContentVersion, migrateAndSeed, migrateDatabase, openDatabase } from "../src/database.js";

const SOURCE = resolve(import.meta.dirname, "../..");
const SOURCE_FILE = resolve(SOURCE, "daily-english-high-frequency-sentences.md");

function previousCorpus() {
  const db = openDatabase({ databasePath: ":memory:" });
  migrateDatabase(db);
  db.prepare("INSERT INTO app_meta(key, value) VALUES (?, '1')").run(TRAVEL_SHOPPING_UPDATE);
  migrateAndSeed(db, SOURCE);
  db.prepare("DELETE FROM app_meta WHERE key = ?").run(TRAVEL_SHOPPING_UPDATE);
  return db;
}

test("travel shopping upgrade appends 24 stable items and preserves existing content and learning history", () => {
  const db = previousCorpus();
  try {
    const now = Date.now();
    const existing = db.prepare("SELECT id FROM items WHERE item_key = 'sentence-0001'").get() as { id: string };
    db.prepare("UPDATE items SET meaning = '保留管理员修改', status = 'archived', archived_at = ?, revision = 2 WHERE id = ?")
      .run(now, existing.id);
    db.prepare("INSERT INTO item_revisions(item_id, revision, action, snapshot_json, created_at) VALUES (?, 2, 'edit', '{}', ?)")
      .run(existing.id, now);
    db.prepare(`INSERT INTO users(id, username, display_name, password_hash, role, created_at, updated_at)
      VALUES ('existing-learner', 'traveler', '学习者', 'unchanged', 'user', ?, ?)`).run(now, now);
    db.prepare("INSERT INTO practice_sessions(id, user_id, mode, started_at) VALUES ('existing-practice', 'existing-learner', 'sequential', ?)")
      .run(now);
    db.prepare(`INSERT INTO attempts(id, client_attempt_id, practice_session_id, user_id, item_id, correct, first_try_correct, occurred_at, created_at, item_revision)
      VALUES ('existing-attempt', 'client-attempt', 'existing-practice', 'existing-learner', ?, 0, 0, ?, ?, 1)`)
      .run(existing.id, now, now);
    db.prepare("INSERT INTO progress(user_id, item_id, attempt_count, wrong_count, is_mistake, updated_at) VALUES ('existing-learner', ?, 1, 1, 1, ?)")
      .run(existing.id, now);

    const categories = db.prepare("SELECT * FROM categories ORDER BY slug").all();
    const items = db.prepare("SELECT * FROM items ORDER BY item_key").all();
    const tables = ["users", "sessions", "practice_sessions", "attempts", "progress", "import_batches", "import_batch_items"];
    const learningData = () => tables.map((table) => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());
    const originalHistory = learningData();

    assert.deepEqual(migrateAndSeed(db, SOURCE), { categoriesInserted: 1, itemsInserted: 24, words: 850, sentences: 502 });
    assert.deepEqual(db.prepare("SELECT * FROM categories WHERE slug <> 'sentences-23' ORDER BY slug").all(), categories);
    assert.deepEqual(db.prepare("SELECT * FROM items WHERE item_key NOT BETWEEN 'sentence-0271' AND 'sentence-0294' ORDER BY item_key").all(), items);
    assert.deepEqual(learningData(), originalHistory);

    const source = parseSentenceMarkdown(readFileSync(SOURCE_FILE, "utf8")).items.filter((item) => item.categorySlug === "sentences-23");
    const added = db.prepare(`SELECT i.item_key AS key, i.english, i.meaning, i.pronunciation, i.sort_order AS sortOrder
      FROM items i JOIN categories c ON c.id = i.category_id
      WHERE c.slug = 'sentences-23' AND c.status = 'published' AND i.status = 'published' ORDER BY i.sort_order`).all();
    assert.deepEqual(added, source.map(({ key, english, meaning, pronunciation, sortOrder }) =>
      ({ key, english, meaning, pronunciation, sortOrder })));
    assert.equal(source.length, 24);
    assert.equal(source[0]!.english, "How much is this one?");
    assert.equal(source[23]!.english, "Could I get a receipt, please?");

    db.prepare("UPDATE categories SET name = '管理员改名', status = 'draft' WHERE slug = 'sentences-23'").run();
    const afterEdit = db.serialize();
    assert.deepEqual(applyTravelShoppingUpdate(db, () => { throw new Error("completed update must skip the source"); },
      () => bumpContentVersion(db)), { categoriesInserted: 0, itemsInserted: 0 });
    assert.deepEqual(db.serialize(), afterEdit);
  } finally {
    db.close();
  }
});

test("a conflict on the last travel shopping key rolls back the whole category", () => {
  const db = previousCorpus();
  try {
    const existing = db.prepare("SELECT id FROM categories WHERE slug = 'sentences-1'").get() as { id: string };
    db.prepare(`INSERT INTO items(id, item_key, category_id, kind, english, meaning, normalized_answer, created_at, updated_at)
      VALUES ('travel-conflict', 'sentence-0294', ?, 'sentence', 'An existing draft.', '现有草稿', 'an existing draft.', 1, 1)`)
      .run(existing.id);
    const before = db.serialize();
    assert.throws(() => migrateAndSeed(db, SOURCE), /Travel shopping update conflict: item sentence-0294/);
    assert.deepEqual(db.serialize(), before);
  } finally {
    db.close();
  }
});

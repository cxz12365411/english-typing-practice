import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { bumpContentVersion, migrateAndSeed, migrateDatabase, openDatabase } from "../src/database.js";
import {
  applyGaokaoWritingUpdate, GAOKAO_WRITING_SOURCE, GAOKAO_WRITING_UPDATE, parseGaokaoWritingContent
} from "../src/gaokao-writing.js";
import { GRADUATE_WRITING_UPDATE } from "../src/graduate-writing.js";

const SOURCE = resolve(import.meta.dirname, "../..");

interface BilingualText { english: string; meaning: string }
interface Source {
  sourceLabel: string;
  essays: Array<{
    id: string;
    title: string;
    type: string;
    reading?: { english: string; summary: string };
    paragraphStarts?: BilingualText[];
    paragraphs: Array<Array<BilingualText & { key: string }>>;
  }>;
}

function readSource(): Source {
  return JSON.parse(readFileSync(resolve(SOURCE, GAOKAO_WRITING_SOURCE), "utf8")) as Source;
}

function previousCorpus() {
  const db = openDatabase({ databasePath: ":memory:" });
  migrateDatabase(db);
  db.prepare("INSERT INTO app_meta(key, value) VALUES (?, '1'), (?, '1')").run(GAOKAO_WRITING_UPDATE, GRADUATE_WRITING_UPDATE);
  migrateAndSeed(db, SOURCE);
  db.prepare("DELETE FROM app_meta WHERE key = ?").run(GAOKAO_WRITING_UPDATE);
  return db;
}

test("Gaokao source publishes only the 76 essay body sentences under their stable category IDs", () => {
  const source = readSource();
  const parsed = parseGaokaoWritingContent(source);
  assert.equal(source.sourceLabel, "原创模拟题与参考范文");
  assert.deepEqual(parsed.categories.map(({ slug, name, sortOrder }) => [slug, name, sortOrder]),
    source.essays.map(({ id, title, type }, index) => [
      id, `${type === "application" ? "高考应用文" : "高考读后续写"}：${title}`, 300 + index
    ]));
  assert.equal(parsed.categories.length, 10);
  assert.equal(parsed.items.length, 76);
  assert.deepEqual(parsed.items.map(({ key, english, meaning, categorySlug, sortOrder }) =>
    ({ key, english, meaning, categorySlug, sortOrder })), source.essays.flatMap(({ id, paragraphs }) =>
      paragraphs.flat().map(({ key, english, meaning }, index) => ({ key, english, meaning, categorySlug: id, sortOrder: index + 1 }))));
});

test("Gaokao parser rejects invalid keys, exercise structure, prompt material and essay lengths", () => {
  const mutations: Array<(source: Source) => void> = [
    (source) => { source.essays[1]!.id = source.essays[0]!.id; },
    (source) => { source.essays[0]!.type = "continuation"; },
    (source) => { source.essays[0]!.paragraphs[0]![0]!.key = "gaokao-e01-s02"; },
    (source) => { source.essays[0]!.paragraphs[0]![0]!.meaning = " "; },
    (source) => { source.essays[0]!.paragraphs[0]![0]!.english += " extra".repeat(100); },
    (source) => { delete source.essays[6]!.reading; },
    (source) => { source.essays[6]!.reading!.english = "Too short."; },
    (source) => { source.essays[6]!.paragraphStarts!.pop(); },
    (source) => { source.essays[6]!.paragraphs[1]!.pop(); },
    (source) => { source.essays[6]!.paragraphs[0]![0]!.english = source.essays[6]!.paragraphStarts![0]!.english; }
  ];
  const source = readSource();
  for (const mutate of mutations) {
    const data = structuredClone(source);
    mutate(data);
    assert.throws(() => parseGaokaoWritingContent(data), /Gaokao writing source integrity check failed/);
  }
});

test("Gaokao migration appends published content once and preserves administrator edits and learning records", () => {
  const db = previousCorpus();
  try {
    const now = Date.now();
    const originalItem = db.prepare("SELECT id FROM items WHERE item_key = 'sentence-0001'").get() as { id: string };
    db.prepare("UPDATE items SET meaning = '保留管理员修改', status = 'archived', archived_at = ?, revision = 2 WHERE id = ?")
      .run(now, originalItem.id);
    db.prepare("INSERT INTO item_revisions(item_id, revision, action, snapshot_json, created_at) VALUES (?, 2, 'edit', '{}', ?)")
      .run(originalItem.id, now);
    db.prepare(`INSERT INTO users(id, username, display_name, password_hash, role, created_at, updated_at)
      VALUES ('gaokao-learner', 'gaokao-learner', '学习者', 'unchanged', 'user', ?, ?)`).run(now, now);
    db.prepare(`INSERT INTO practice_sessions(id, user_id, mode, started_at)
      VALUES ('gaokao-practice', 'gaokao-learner', 'sequential', ?)`).run(now);
    db.prepare(`INSERT INTO attempts(id, client_attempt_id, practice_session_id, user_id, item_id, correct, first_try_correct, occurred_at, created_at, item_revision)
      VALUES ('gaokao-attempt', 'client-attempt', 'gaokao-practice', 'gaokao-learner', ?, 0, 0, ?, ?, 1)`)
      .run(originalItem.id, now, now);
    db.prepare(`INSERT INTO progress(user_id, item_id, attempt_count, wrong_count, is_mistake, updated_at)
      VALUES ('gaokao-learner', ?, 1, 1, 1, ?)`).run(originalItem.id, now);

    const previousCategories = db.prepare("SELECT * FROM categories ORDER BY slug").all();
    const previousItems = db.prepare("SELECT * FROM items ORDER BY item_key").all();
    const previousRevisions = db.prepare("SELECT * FROM item_revisions ORDER BY rowid").all();
    const protectedTables = ["users", "sessions", "practice_sessions", "attempts", "progress", "import_batches", "import_batch_items"];
    const learningData = () => protectedTables.map((table) => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());
    const previousLearningData = learningData();
    const version = db.prepare("SELECT value FROM app_meta WHERE key = 'content_version'");
    const previousVersion = Number((version.get() as { value: string }).value);

    assert.deepEqual(migrateAndSeed(db, SOURCE), { categoriesInserted: 10, itemsInserted: 76, words: 850, sentences: 578 });
    assert.deepEqual(version.get(), { value: String(previousVersion + 1) });
    assert.deepEqual(db.prepare("SELECT * FROM categories WHERE slug NOT LIKE 'gaokao-%' ORDER BY slug").all(), previousCategories);
    assert.deepEqual(db.prepare("SELECT * FROM items WHERE item_key NOT LIKE 'gaokao-%' ORDER BY item_key").all(), previousItems);
    assert.deepEqual(db.prepare(`SELECT item_revisions.* FROM item_revisions JOIN items ON items.id = item_revisions.item_id
      WHERE items.item_key NOT LIKE 'gaokao-%' ORDER BY item_revisions.rowid`).all(), previousRevisions);
    assert.deepEqual(learningData(), previousLearningData);
    const rows = db.prepare(`SELECT i.item_key AS key, c.slug AS categorySlug, i.kind, i.english, i.meaning, i.pronunciation, i.sort_order AS sortOrder
      FROM items i JOIN categories c ON c.id = i.category_id JOIN item_revisions r ON r.item_id = i.id
      WHERE c.slug LIKE 'gaokao-%' AND i.status = 'published' AND c.status = 'published'
      AND r.action = 'content_update' AND r.revision = 1 ORDER BY c.sort_order, i.sort_order`).all();
    assert.deepEqual(rows, parseGaokaoWritingContent(readSource()).items);
    const audit = db.prepare("SELECT metadata_json FROM audit_log WHERE target_id = ?").get(GAOKAO_WRITING_UPDATE) as { metadata_json: string };
    assert.deepEqual(JSON.parse(audit.metadata_json), {
      source: GAOKAO_WRITING_SOURCE, categories: 10, items: 76, categoriesInserted: 10, itemsInserted: 76
    });

    db.prepare("UPDATE categories SET name = '管理员编辑', status = 'draft' WHERE slug = 'gaokao-essay-01'").run();
    db.prepare("UPDATE items SET meaning = '管理员编辑', revision = 2 WHERE item_key = 'gaokao-e01-s01'").run();
    const afterEdit = db.serialize();
    assert.deepEqual(applyGaokaoWritingUpdate(db, () => { throw new Error("completed update must skip source"); },
      () => bumpContentVersion(db)), { categoriesInserted: 0, itemsInserted: 0 });
    assert.deepEqual(db.serialize(), afterEdit);
  } finally {
    db.close();
  }
});

test("a conflict at the final Gaokao sentence rolls back the entire update", () => {
  const db = previousCorpus();
  try {
    const category = db.prepare("SELECT id FROM categories WHERE slug = 'sentences-1'").get() as { id: string };
    db.prepare(`INSERT INTO items(id, item_key, category_id, kind, english, meaning, normalized_answer, created_at, updated_at)
      VALUES ('gaokao-conflict', 'gaokao-e10-s10', ?, 'sentence', 'An existing draft.', '现有草稿', 'an existing draft.', 1, 1)`)
      .run(category.id);
    const before = db.serialize();
    assert.throws(() => migrateAndSeed(db, SOURCE), /Gaokao writing update conflict: item gaokao-e10-s10/);
    assert.deepEqual(db.serialize(), before);
  } finally {
    db.close();
  }
});

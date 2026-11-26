import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { bumpContentVersion, migrateAndSeed, migrateDatabase, openDatabase } from "../src/database.js";
import {
  applyGraduateWritingUpdate, GRADUATE_WRITING_SOURCE, GRADUATE_WRITING_UPDATE, parseGraduateWritingContent
} from "../src/graduate-writing.js";

const SOURCE = resolve(import.meta.dirname, "../..");

interface BilingualText { english: string; meaning: string }
interface Source {
  sourceLabel: string;
  essays: Array<{
    id: string;
    title: string;
    track: string;
    type: string;
    material?: { kind: "picture"; english: string; meaning: string } |
      { kind: "table"; caption: string; columns: string[]; rows: string[][] };
    paragraphs: Array<Array<BilingualText & { key: string }>>;
  }>;
}

function readSource(): Source {
  return JSON.parse(readFileSync(resolve(SOURCE, GRADUATE_WRITING_SOURCE), "utf8")) as Source;
}

function previousCorpus() {
  const db = openDatabase({ databasePath: ":memory:" });
  migrateDatabase(db);
  db.prepare("INSERT INTO app_meta(key, value) VALUES (?, '1')").run(GRADUATE_WRITING_UPDATE);
  migrateAndSeed(db, SOURCE);
  db.prepare("DELETE FROM app_meta WHERE key = ?").run(GRADUATE_WRITING_UPDATE);
  return db;
}

test("graduate writing publishes 60 bilingual body sentences under eight ordered categories", () => {
  const source = readSource();
  const { categories, items } = parseGraduateWritingContent(source);
  assert.equal(source.sourceLabel, "原创模拟题与参考范文");
  assert.equal(categories.length, 8);
  assert.equal(items.length, 60);
  assert.deepEqual(categories.map(({ slug, name, sortOrder }) => [slug, name, sortOrder]),
    source.essays.map(({ id, title, track, type }, index) => [
      id, `考研英语${track === "one" ? "一" : "二"}·${type === "short" ? "小" : "大"}作文：${title}`, 320 + index
    ]));
  assert.deepEqual(items.map(({ key, english, meaning, categorySlug, sortOrder }) =>
    ({ key, english, meaning, categorySlug, sortOrder })), source.essays.flatMap(({ id, paragraphs }) =>
      paragraphs.flat().map(({ key, english, meaning }, index) => ({ key, english, meaning, categorySlug: id, sortOrder: index + 1 }))));
});

test("graduate writing rejects mismatched tracks, unstable keys, incorrect lengths, and malformed materials", () => {
  const mutations: Array<(source: Source) => void> = [
    (source) => { source.essays[1]!.track = "two"; },
    (source) => { source.essays[0]!.paragraphs[0]![0]!.key = "grad-e01-s02"; },
    (source) => { source.essays[0]!.paragraphs[0]![0]!.meaning = " "; },
    (source) => { source.essays[2]!.paragraphs[0]![0]!.english += " extra".repeat(200); },
    (source) => { delete source.essays[2]!.material; },
    (source) => { source.essays[6]!.material = { kind: "table", caption: "Test", columns: ["A", "B"], rows: [["Only one cell"]] }; },
    (source) => { source.essays[6]!.material = { kind: "picture", english: "A picture.", meaning: "一幅画。" }; },
    (source) => {
      source.essays[1]!.paragraphs[0]![0]!.english = source.essays[0]!.paragraphs[0]![0]!.english;
    }
  ];
  const source = readSource();
  for (const mutate of mutations) {
    const changed = structuredClone(source);
    mutate(changed);
    assert.throws(() => parseGraduateWritingContent(changed), /Graduate writing source integrity check failed/);
  }
});

test("graduate migration preserves the active corpus and progress and runs once", () => {
  const db = previousCorpus();
  try {
    const now = Date.now();
    const item = db.prepare("SELECT id FROM items WHERE item_key = 'gaokao-e01-s01'").get() as { id: string };
    db.prepare("UPDATE items SET meaning = '保留管理员修改', status = 'draft', revision = 2 WHERE id = ?").run(item.id);
    db.prepare(`INSERT INTO users(id, username, display_name, password_hash, role, created_at, updated_at)
      VALUES ('graduate-learner', 'graduate-learner', '学习者', 'unchanged', 'user', ?, ?)`).run(now, now);
    db.prepare(`INSERT INTO progress(user_id, item_id, attempt_count, wrong_count, is_mistake, updated_at)
      VALUES ('graduate-learner', ?, 1, 1, 1, ?)`).run(item.id, now);
    const existingItems = db.prepare("SELECT * FROM items WHERE item_key NOT LIKE 'grad-%' ORDER BY item_key");
    const previousItems = existingItems.all();
    const progress = db.prepare("SELECT * FROM progress");
    const previousProgress = progress.all();
    const version = db.prepare("SELECT value FROM app_meta WHERE key = 'content_version'");
    const previousVersion = Number((version.get() as { value: string }).value);

    assert.deepEqual(migrateAndSeed(db, SOURCE), { categoriesInserted: 8, itemsInserted: 60, words: 850, sentences: 638 });
    assert.deepEqual(existingItems.all(), previousItems);
    assert.deepEqual(progress.all(), previousProgress);
    assert.deepEqual(version.get(), { value: String(previousVersion + 1) });
    const rows = db.prepare(`SELECT i.item_key AS key, c.slug AS categorySlug, i.kind, i.english, i.meaning, i.pronunciation, i.sort_order AS sortOrder
      FROM items i JOIN categories c ON c.id = i.category_id JOIN item_revisions r ON r.item_id = i.id
      WHERE c.slug LIKE 'grad-%' AND i.status = 'published' AND c.status = 'published'
      AND r.action = 'content_update' AND r.revision = 1 ORDER BY c.sort_order, i.sort_order`).all();
    assert.deepEqual(rows, parseGraduateWritingContent(readSource()).items);
    const audit = db.prepare("SELECT metadata_json FROM audit_log WHERE target_id = ?").get(GRADUATE_WRITING_UPDATE) as { metadata_json: string };
    assert.deepEqual(JSON.parse(audit.metadata_json), {
      source: GRADUATE_WRITING_SOURCE, categories: 8, items: 60, categoriesInserted: 8, itemsInserted: 60
    });

    db.prepare("UPDATE items SET meaning = '管理员编辑', revision = 2 WHERE item_key = 'grad-e01-s01'").run();
    const edited = db.serialize();
    assert.deepEqual(applyGraduateWritingUpdate(db, () => { throw new Error("completed update must skip source"); },
      () => bumpContentVersion(db)), { categoriesInserted: 0, itemsInserted: 0 });
    assert.deepEqual(db.serialize(), edited);
  } finally {
    db.close();
  }
});

test("a conflict at the final graduate sentence rolls back the entire update", () => {
  const db = previousCorpus();
  try {
    const category = db.prepare("SELECT id FROM categories WHERE slug = 'sentences-1'").get() as { id: string };
    db.prepare(`INSERT INTO items(id, item_key, category_id, kind, english, meaning, normalized_answer, created_at, updated_at)
      VALUES ('graduate-conflict', 'grad-e08-s09', ?, 'sentence', 'An existing draft.', '现有草稿', 'an existing draft.', 1, 1)`)
      .run(category.id);
    const before = db.serialize();
    assert.throws(() => migrateAndSeed(db, SOURCE), /Graduate writing update conflict: item grad-e08-s09/);
    assert.deepEqual(db.serialize(), before);
  } finally {
    db.close();
  }
});

import assert from "node:assert/strict";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { applyCet4WritingUpdate, CET4_WRITING_UPDATE, countCet4Words, parseCet4WritingContent } from "../src/cet4-writing.js";
import { applyContentUpdates } from "../src/content-updates.js";
import { parseSentenceMarkdown, parseWordMarkdown } from "../src/content-parser.js";
import { bumpContentVersion, migrateAndSeed, migrateDatabase, openDatabase, seedContent, type SqliteDatabase } from "../src/database.js";

const SOURCE = resolve(import.meta.dirname, "../..");

function fixture() {
  return {
    version: 1,
    essays: Array.from({ length: 10 }, (_, index) => ({
      id: `cet4-essay-${String(index + 1).padStart(2, "0")}`,
      title: `测试范文${index + 1}`, titleEnglish: `Test essay ${index + 1}`,
      prompt: "Write an original essay.", outline: ["测试结构。"],
      paragraphs: Array.from({ length: 2 }, (_, paragraph) => Array.from({ length: 2 }, (_, sentence) => ({
        key: `cet4-e${String(index + 1).padStart(2, "0")}-s${String(paragraph * 2 + sentence + 1).padStart(2, "0")}`,
        english: `${Array.from({ length: 30 }, (_, word) => `word${index}${paragraph}${sentence}${word}`).join(" ")}.`,
        meaning: `测试翻译${paragraph}-${sentence}。`
      })))
    })),
    expressionGroups: [
      ["opening", "开头引入"], ["argument", "观点论证"],
      ["transition", "衔接转折"], ["conclusion", "总结建议"]
    ].map(([suffix, title]) => ({
      id: `cet4-phrases-${suffix}`, title,
      items: Array.from({ length: 10 }, (_, index) => ({
        key: `cet4-${suffix}-${String(index + 1).padStart(2, "0")}`,
        english: `This is example ${index + 1} for ${suffix}.`, meaning: `这是例句${index + 1}。`
      }))
    }))
  };
}

function sourceDirectory(source = fixture()): string {
  const directory = mkdtempSync(resolve(tmpdir(), "cet4-content-test-"));
  for (const file of ["basic-english-850.md", "daily-english-high-frequency-sentences.md"]) {
    copyFileSync(resolve(SOURCE, file), resolve(directory, file));
  }
  writeFileSync(resolve(directory, "cet4-writing.json"), JSON.stringify(source));
  return directory;
}

function count(db: SqliteDatabase, table: string): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}

function snapshot(db: SqliteDatabase): string {
  return JSON.stringify(["app_meta", "users", "sessions", "categories", "items", "item_revisions", "practice_sessions", "attempts", "progress", "audit_log"]
    .map((table) => [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
}

function oldDatabase(): SqliteDatabase {
  const db = openDatabase({ databasePath: ":memory:" });
  migrateDatabase(db);
  seedContent(db, SOURCE);
  applyContentUpdates(db, () => ({
    categories: [...parseWordMarkdown(readFileSync(resolve(SOURCE, "basic-english-850.md"), "utf8")).categories,
      ...parseSentenceMarkdown(readFileSync(resolve(SOURCE, "daily-english-high-frequency-sentences.md"), "utf8")).categories],
    items: [...parseWordMarkdown(readFileSync(resolve(SOURCE, "basic-english-850.md"), "utf8")).items,
      ...parseSentenceMarkdown(readFileSync(resolve(SOURCE, "daily-english-high-frequency-sentences.md"), "utf8")).items]
  }), () => bumpContentVersion(db));
  return db;
}

test("CET4 parser preserves stable sentence order and validates release identities, structure and word limits", () => {
  const parsed = parseCet4WritingContent(fixture());
  assert.equal(parsed.categories.length, 14);
  assert.equal(parsed.items.length, 80);
  assert.deepEqual(parsed.categories.map((category) => category.sortOrder), Array.from({ length: 14 }, (_, i) => 100 + i));
  assert.deepEqual(parsed.items.slice(0, 4).map((item) => [item.key, item.sortOrder]), [
    ["cet4-e01-s01", 1], ["cet4-e01-s02", 2], ["cet4-e01-s03", 3], ["cet4-e01-s04", 4]
  ]);
  assert.ok(parsed.items.every((item) => item.pronunciation === "" && item.kind === "sentence"));
  assert.equal(countCet4Words("It's well-known that 40% prefer e-books in 2026."), 8);
  const reordered = fixture();
  reordered.essays[0]!.paragraphs[0]!.reverse();
  assert.deepEqual(parseCet4WritingContent(reordered).items.slice(0, 2).map((item) => [item.key, item.sortOrder]), [
    ["cet4-e01-s02", 1], ["cet4-e01-s01", 2]
  ]);
  const mutations = [
    (source: ReturnType<typeof fixture>) => { source.version = 2; },
    (source: ReturnType<typeof fixture>) => { source.essays.pop(); },
    (source: ReturnType<typeof fixture>) => { source.expressionGroups[0]!.items.pop(); },
    (source: ReturnType<typeof fixture>) => { source.essays[1]!.id = source.essays[0]!.id; },
    (source: ReturnType<typeof fixture>) => { source.essays[0]!.paragraphs[0]![0]!.key = "sentence-0001"; },
    (source: ReturnType<typeof fixture>) => { source.essays[0]!.paragraphs[0]![0]!.key = "cet4-e01-s00"; },
    (source: ReturnType<typeof fixture>) => { source.essays[0]!.paragraphs[0]![0]!.key = "cet4-e01-s02"; },
    (source: ReturnType<typeof fixture>) => { source.essays[0]!.paragraphs[0]![0]!.meaning = " "; },
    (source: ReturnType<typeof fixture>) => { source.essays[0]!.paragraphs[0] = []; },
    (source: ReturnType<typeof fixture>) => { source.essays[0]!.outline = []; },
    (source: ReturnType<typeof fixture>) => { source.essays[0]!.paragraphs[0]![0]!.english = "Too short."; },
    (source: ReturnType<typeof fixture>) => { source.essays[0]!.paragraphs[0]![0]!.english += " extra".repeat(61); }
  ];
  for (const mutate of mutations) {
    const source = fixture();
    mutate(source);
    assert.throws(() => parseCet4WritingContent(source), /CET4 writing source integrity check failed/);
  }
});

test("fresh installation atomically adds CET4 content, revisions, version and audit exactly once", () => {
  const directory = sourceDirectory();
  const db = openDatabase({ databasePath: ":memory:" });
  try {
    assert.deepEqual(migrateAndSeed(db, directory), { categoriesInserted: 40, itemsInserted: 1200, words: 850, sentences: 350 });
    assert.equal(count(db, "item_revisions"), 1200);
    assert.equal(count(db, "items WHERE item_key LIKE 'cet4-%' AND status = 'published'"), 80);
    assert.deepEqual(db.prepare("SELECT value FROM app_meta WHERE key = 'content_version'").get(), { value: "2" });
    const audit = db.prepare("SELECT metadata_json FROM audit_log WHERE target_id = ?").get(CET4_WRITING_UPDATE) as { metadata_json: string };
    assert.deepEqual(JSON.parse(audit.metadata_json), { source: "cet4-writing.json", categories: 14, items: 80, categoriesInserted: 14, itemsInserted: 80 });
    const before = snapshot(db);
    rmSync(directory, { recursive: true });
    assert.deepEqual(migrateAndSeed(db, directory), { categoriesInserted: 0, itemsInserted: 0, words: 850, sentences: 350 });
    assert.equal(snapshot(db), before);
  } finally { db.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("CET4 upgrade preserves original content, administrator changes, users and learning history", () => {
  const directory = sourceDirectory();
  const db = oldDatabase();
  try {
    const now = Date.now();
    const item = db.prepare("SELECT id FROM items WHERE item_key = 'sentence-0001'").get() as { id: string };
    db.prepare("UPDATE items SET meaning = '保留管理员修改', revision = 2, status = 'archived', archived_at = ? WHERE id = ?").run(now, item.id);
    db.prepare("INSERT INTO users(id, username, display_name, password_hash, role, created_at, updated_at) VALUES ('cet4-user', 'cet4-learner', 'Learner', 'unchanged', 'user', ?, ?)").run(now, now);
    db.prepare("INSERT INTO practice_sessions(id, user_id, mode, started_at) VALUES ('cet4-practice', 'cet4-user', 'sequential', ?)").run(now);
    db.prepare("INSERT INTO attempts(id, client_attempt_id, practice_session_id, user_id, item_id, correct, first_try_correct, occurred_at, created_at, item_revision) VALUES ('cet4-attempt', 'cet4-client', 'cet4-practice', 'cet4-user', ?, 0, 0, ?, ?, 1)").run(item.id, now, now);
    db.prepare("INSERT INTO progress(user_id, item_id, attempt_count, wrong_count, is_mistake, updated_at) VALUES ('cet4-user', ?, 1, 1, 1, ?)").run(item.id, now);
    const oldItems = db.prepare("SELECT * FROM items ORDER BY item_key").all();
    const oldCategories = db.prepare("SELECT * FROM categories ORDER BY slug").all();
    const tables = ["users", "practice_sessions", "attempts", "progress"];
    const history = tables.map((table) => db.prepare(`SELECT * FROM ${table}`).all());
    assert.deepEqual(migrateAndSeed(db, directory), { categoriesInserted: 14, itemsInserted: 80, words: 850, sentences: 350 });
    assert.deepEqual(db.prepare("SELECT * FROM items WHERE item_key NOT LIKE 'cet4-%' ORDER BY item_key").all(), oldItems);
    assert.deepEqual(db.prepare("SELECT * FROM categories WHERE slug NOT LIKE 'cet4-%' ORDER BY slug").all(), oldCategories);
    assert.deepEqual(tables.map((table) => db.prepare(`SELECT * FROM ${table}`).all()), history);
    db.prepare("UPDATE items SET english = 'Later administrator change.', status = 'archived', archived_at = ?, revision = 2 WHERE item_key = 'cet4-e01-s01'").run(now);
    db.prepare("UPDATE categories SET name = '管理员分类', status = 'draft' WHERE slug = 'cet4-essay-01'").run();
    const before = snapshot(db);
    assert.deepEqual(applyCet4WritingUpdate(db, () => { throw new Error("must not read changed source"); }, () => bumpContentVersion(db)), { categoriesInserted: 0, itemsInserted: 0 });
    assert.equal(snapshot(db), before);
  } finally { db.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("late item and category conflicts roll back the entire CET4 patch", () => {
  for (const collision of ["item", "category", "unrelated"]) {
    const db = oldDatabase();
    try {
      const now = Date.now();
      if (collision === "item") {
        const category = db.prepare("SELECT id FROM categories LIMIT 1").get() as { id: string };
        db.prepare(`INSERT INTO items(id, item_key, category_id, kind, english, meaning, normalized_answer, created_at, updated_at)
          VALUES ('collision-item', 'cet4-conclusion-10', ?, 'sentence', 'Keep my draft.', '保留', 'keep my draft.', ?, ?)`)
          .run(category.id, now, now);
      } else {
        db.prepare(`INSERT INTO categories(id, slug, name, kind, sort_order, status, created_at, updated_at, published_at)
          VALUES ('collision-category', 'cet4-phrases-conclusion', ?, 'sentence', 113, 'published', ?, ?, ?)`)
          .run(collision === "unrelated" ? "四级句型：总结建议" : "管理员分类", now, now, now);
        if (collision === "unrelated") db.prepare(`INSERT INTO items(id, item_key, category_id, kind, english, meaning, normalized_answer, created_at, updated_at)
          VALUES ('private-item', 'private-key', 'collision-category', 'sentence', 'A private row.', '保留', 'a private row.', ?, ?)`)
          .run(now, now);
      }
      const before = snapshot(db);
      assert.throws(() => applyCet4WritingUpdate(db, fixture, () => bumpContentVersion(db)), /CET4 writing update conflict/);
      assert.equal(snapshot(db), before);
      assert.equal(db.prepare("SELECT value FROM app_meta WHERE key = ?").get(CET4_WRITING_UPDATE), undefined);
    } finally { db.close(); }
  }
});

test("missing, malformed and invalid release resources leave the existing corpus untouched", () => {
  for (const invalid of [undefined, "not json", JSON.stringify({ version: 1 })]) {
    const directory = sourceDirectory();
    const db = oldDatabase();
    try {
      if (invalid === undefined) rmSync(resolve(directory, "cet4-writing.json"));
      else writeFileSync(resolve(directory, "cet4-writing.json"), invalid);
      const before = snapshot(db);
      assert.throws(() => migrateAndSeed(db, directory));
      assert.equal(snapshot(db), before);
    } finally { db.close(); rmSync(directory, { recursive: true, force: true }); }
  }
  const directory = sourceDirectory();
  const db = openDatabase({ databasePath: ":memory:" });
  try {
    rmSync(resolve(directory, "cet4-writing.json"));
    assert.throws(() => migrateAndSeed(db, directory), /ENOENT/);
    assert.equal(count(db, "items"), 0);
    assert.equal(count(db, "categories"), 0);
    assert.equal(count(db, "app_meta"), 0);
    assert.equal(count(db, "audit_log"), 0);
  } finally { db.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("the published CET4 source passes the same production parser", () => {
  const parsed = parseCet4WritingContent(JSON.parse(readFileSync(resolve(SOURCE, "cet4-writing.json"), "utf8")));
  assert.equal(parsed.categories.length, 14);
  assert.equal(parsed.items.filter((item) => item.categorySlug.startsWith("cet4-phrases-")).length, 40);
});

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { applyCet6WritingUpdate, CET6_WRITING_UPDATE, parseCet6WritingContent } from "../src/cet6-writing.js";
import { bumpContentVersion, migrateAndSeed, openDatabase } from "../src/database.js";
const SOURCE = resolve(import.meta.dirname, "../..");
const data = JSON.parse(readFileSync(resolve(SOURCE, "cet6-writing.json"), "utf8"));
const load = () => structuredClone(data);

test("six advanced essays and 24 expressions have stable identities and valid length", () => {
  const parsed = parseCet6WritingContent(data);
  assert.equal(parsed.categories.length, 10);
  assert.equal(parsed.items.length, 78);
  assert.equal(new Set(parsed.items.map(x => x.key)).size, 78);
  for (const mutate of [
    (x: any) => x.essays.pop(),
    (x: any) => x.expressionGroups[0].items.pop(),
    (x: any) => x.essays[0].paragraphs[0].splice(0),
    (x: any) => x.essays[0].paragraphs[0][0].english = "short",
    (x: any) => x.essays[0].id = "cet4-essay-01",
    (x: any) => x.level = 4
  ]) {
    const invalid = load(); mutate(invalid);
    assert.throws(() => parseCet6WritingContent(invalid));
  }
});

test("CET6 upgrades preserve existing rows and skip all source reads after completion", () => {
  const db = openDatabase({ databasePath: ":memory:" });
  try {
    migrateAndSeed(db, SOURCE);
    // Reproduce a database immediately before this one-shot content update.
    db.prepare("DELETE FROM item_revisions WHERE item_id IN (SELECT id FROM items WHERE item_key LIKE 'cet6-%')").run();
    db.prepare("DELETE FROM items WHERE item_key LIKE 'cet6-%'").run();
    db.prepare("DELETE FROM categories WHERE slug LIKE 'cet6-%'").run();
    db.prepare("DELETE FROM app_meta WHERE key = ?").run(CET6_WRITING_UPDATE);
    const old = db.prepare("SELECT * FROM items ORDER BY id").all();
    assert.deepEqual(applyCet6WritingUpdate(db, load, () => bumpContentVersion(db)), { categoriesInserted: 10, itemsInserted: 78 });
    assert.deepEqual(db.prepare("SELECT * FROM items WHERE item_key NOT LIKE 'cet6-%' ORDER BY id").all(), old);
    db.prepare("UPDATE items SET english = 'Administrator edit', revision = 2 WHERE item_key = 'cet6-e01-s01'").run();
    assert.deepEqual(applyCet6WritingUpdate(db, () => { throw Error("Must not read"); }, () => bumpContentVersion(db)), { categoriesInserted: 0, itemsInserted: 0 });
    assert.equal((db.prepare("SELECT english FROM items WHERE item_key = 'cet6-e01-s01'").get() as any).english, "Administrator edit");
    // Existing edited ID conflicts roll back without modifying anything.
    db.prepare("DELETE FROM app_meta WHERE key = ?").run(CET6_WRITING_UPDATE);
    const snapshot = db.serialize();
    assert.throws(() => applyCet6WritingUpdate(db, load, () => bumpContentVersion(db)), /conflict/);
    assert.deepEqual(db.serialize(), snapshot);
  } finally { db.close(); }
});

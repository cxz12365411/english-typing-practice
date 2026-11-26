import { CET6_WRITING_UPDATE } from "../src/cet6-writing.js";
import { CET4_WRITING_UPDATE } from "../src/cet4-writing.js";
import { TRAVEL_SHOPPING_UPDATE } from "../src/content-updates.js";
import { GAOKAO_WRITING_UPDATE } from "../src/gaokao-writing.js";
import { GRADUATE_WRITING_UPDATE } from "../src/graduate-writing.js";
import { migrateAndSeed, migrateDatabase, type SqliteDatabase } from "../src/database.js";

/** Historical street/bar tests exercise the corpus before the later topic updates. */
export function isolatePreCet4Fixture(db: SqliteDatabase): void {
  migrateDatabase(db);
  db.prepare("INSERT INTO app_meta(key, value) VALUES (?, '1') ON CONFLICT(key) DO NOTHING").run(CET4_WRITING_UPDATE);
  db.prepare("INSERT INTO app_meta(key, value) VALUES (?, '1') ON CONFLICT(key) DO NOTHING").run(CET6_WRITING_UPDATE);
  db.prepare("INSERT INTO app_meta(key, value) VALUES (?, '1') ON CONFLICT(key) DO NOTHING").run(TRAVEL_SHOPPING_UPDATE);
  db.prepare("INSERT INTO app_meta(key, value) VALUES (?, '1') ON CONFLICT(key) DO NOTHING").run(GAOKAO_WRITING_UPDATE);
  db.prepare("INSERT INTO app_meta(key, value) VALUES (?, '1') ON CONFLICT(key) DO NOTHING").run(GRADUATE_WRITING_UPDATE);
}

export function migratePreCet4Fixture(db: SqliteDatabase, source?: string) {
  isolatePreCet4Fixture(db);
  return migrateAndSeed(db, source);
}

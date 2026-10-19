import { CET4_WRITING_UPDATE } from "../src/cet4-writing.js";
import { migrateAndSeed, migrateDatabase, type SqliteDatabase } from "../src/database.js";

/** Historical street/bar tests intentionally exercise the corpus before CET4. */
export function isolatePreCet4Fixture(db: SqliteDatabase): void {
  migrateDatabase(db);
  db.prepare("INSERT INTO app_meta(key, value) VALUES (?, '1') ON CONFLICT(key) DO NOTHING").run(CET4_WRITING_UPDATE);
}

export function migratePreCet4Fixture(db: SqliteDatabase, source?: string) {
  isolatePreCet4Fixture(db);
  return migrateAndSeed(db, source);
}

import { loadConfig } from "../config.js";
import { migrateAndSeed, openDatabase } from "../database.js";

const config = loadConfig();
const db = openDatabase(config);
try {
  const result = migrateAndSeed(db, config.contentSourceDir);
  const version = (db.prepare("SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations").get() as { version: number }).version;
  process.stdout.write(
    `${JSON.stringify({ status: "MIGRATED", schemaVersion: version, ...result })}\n`
  );
} finally {
  db.close();
}

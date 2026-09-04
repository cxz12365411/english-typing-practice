import { chmodSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import type { AppConfig } from "./config.js";
import { parseSentenceMarkdown, parseWordMarkdown, type ParsedContent } from "./content-parser.js";

export type SqliteDatabase = Database.Database;

const MIGRATIONS: ReadonlyArray<{ version: number; sql: string }> = [
  {
    version: 1,
    sql: `
      CREATE TABLE app_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      ) STRICT;

      CREATE TABLE users (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL COLLATE NOCASE UNIQUE,
        display_name TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('user', 'admin')),
        active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
        must_change_password INTEGER NOT NULL DEFAULT 1 CHECK (must_change_password IN (0, 1)),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        last_login_at INTEGER
      ) STRICT;

      CREATE TABLE sessions (
        id_hash TEXT PRIMARY KEY,
        csrf_token TEXT NOT NULL,
        csrf_hash TEXT NOT NULL,
        user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
        created_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        absolute_expires_at INTEGER NOT NULL,
        revoked_at INTEGER,
        ip_address TEXT,
        user_agent TEXT
      ) STRICT;
      CREATE INDEX sessions_user_id_idx ON sessions(user_id);
      CREATE INDEX sessions_expiry_idx ON sessions(expires_at, absolute_expires_at);

      CREATE TABLE categories (
        id TEXT PRIMARY KEY,
        slug TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('word', 'sentence')),
        sort_order INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'archived')),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        published_at INTEGER,
        archived_at INTEGER
      ) STRICT;
      CREATE INDEX categories_listing_idx ON categories(status, kind, sort_order);

      CREATE TABLE items (
        id TEXT PRIMARY KEY,
        item_key TEXT NOT NULL UNIQUE,
        category_id TEXT NOT NULL REFERENCES categories(id),
        kind TEXT NOT NULL CHECK (kind IN ('word', 'sentence')),
        english TEXT NOT NULL,
        meaning TEXT NOT NULL,
        pronunciation TEXT NOT NULL DEFAULT '',
        normalized_answer TEXT NOT NULL,
        sort_order INTEGER NOT NULL DEFAULT 0,
        revision INTEGER NOT NULL DEFAULT 1,
        status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'archived')),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        published_at INTEGER,
        archived_at INTEGER
      ) STRICT;
      CREATE INDEX items_listing_idx ON items(status, category_id, sort_order);

      CREATE TABLE item_revisions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
        revision INTEGER NOT NULL,
        action TEXT NOT NULL,
        snapshot_json TEXT NOT NULL,
        changed_by TEXT REFERENCES users(id) ON DELETE SET NULL,
        created_at INTEGER NOT NULL,
        UNIQUE(item_id, revision)
      ) STRICT;

      CREATE TABLE practice_sessions (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        mode TEXT NOT NULL CHECK (mode IN ('sequential', 'random', 'mistakes')),
        category_id TEXT REFERENCES categories(id),
        started_at INTEGER NOT NULL,
        finished_at INTEGER,
        duration_ms INTEGER NOT NULL DEFAULT 0,
        total_attempts INTEGER NOT NULL DEFAULT 0,
        correct_attempts INTEGER NOT NULL DEFAULT 0,
        first_try_correct INTEGER NOT NULL DEFAULT 0,
        current_streak INTEGER NOT NULL DEFAULT 0,
        best_streak INTEGER NOT NULL DEFAULT 0
      ) STRICT;
      CREATE INDEX practice_sessions_user_idx ON practice_sessions(user_id, started_at DESC);

      CREATE TABLE attempts (
        id TEXT PRIMARY KEY,
        client_attempt_id TEXT NOT NULL,
        practice_session_id TEXT NOT NULL REFERENCES practice_sessions(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        item_id TEXT NOT NULL REFERENCES items(id),
        correct INTEGER NOT NULL CHECK (correct IN (0, 1)),
        first_try_correct INTEGER NOT NULL CHECK (first_try_correct IN (0, 1)),
        duration_ms INTEGER NOT NULL DEFAULT 0,
        occurred_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        UNIQUE(user_id, client_attempt_id)
      ) STRICT;
      CREATE INDEX attempts_session_idx ON attempts(practice_session_id, occurred_at);
      CREATE INDEX attempts_user_item_idx ON attempts(user_id, item_id, occurred_at DESC);

      CREATE TABLE progress (
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        item_id TEXT NOT NULL REFERENCES items(id),
        attempt_count INTEGER NOT NULL DEFAULT 0,
        correct_count INTEGER NOT NULL DEFAULT 0,
        first_try_correct_count INTEGER NOT NULL DEFAULT 0,
        wrong_count INTEGER NOT NULL DEFAULT 0,
        is_mistake INTEGER NOT NULL DEFAULT 0 CHECK (is_mistake IN (0, 1)),
        last_attempt_at INTEGER,
        last_wrong_at INTEGER,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY(user_id, item_id)
      ) STRICT;
      CREATE INDEX progress_mistakes_idx ON progress(user_id, is_mistake, last_wrong_at DESC);

      CREATE TABLE login_limits (
        key_type TEXT NOT NULL CHECK (key_type IN ('account', 'ip')),
        key_value TEXT NOT NULL,
        window_started_at INTEGER NOT NULL,
        failure_count INTEGER NOT NULL DEFAULT 0,
        blocked_until INTEGER,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY(key_type, key_value)
      ) STRICT;

      CREATE TABLE import_previews (
        id TEXT PRIMARY KEY,
        created_by TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        category_id TEXT REFERENCES categories(id),
        payload_json TEXT NOT NULL,
        errors_json TEXT NOT NULL,
        row_count INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        committed_at INTEGER
      ) STRICT;
      CREATE INDEX import_previews_expiry_idx ON import_previews(expires_at);

      CREATE TABLE user_imports (
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        import_kind TEXT NOT NULL,
        imported_at INTEGER NOT NULL,
        imported_count INTEGER NOT NULL,
        PRIMARY KEY(user_id, import_kind)
      ) STRICT;

      CREATE TABLE audit_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        actor_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
        action TEXT NOT NULL,
        target_type TEXT,
        target_id TEXT,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        ip_address TEXT,
        created_at INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX audit_log_created_idx ON audit_log(created_at DESC, id DESC);
      CREATE INDEX audit_log_actor_idx ON audit_log(actor_user_id, created_at DESC);
    `
  },
  {
    version: 2,
    sql: `
      ALTER TABLE users ADD COLUMN auth_version INTEGER NOT NULL DEFAULT 1;
      ALTER TABLE sessions ADD COLUMN auth_version INTEGER;
      UPDATE sessions
      SET auth_version = (SELECT auth_version FROM users WHERE users.id = sessions.user_id)
      WHERE user_id IS NOT NULL;
      DELETE FROM sessions WHERE user_id IS NULL;

      ALTER TABLE attempts ADD COLUMN item_revision INTEGER NOT NULL DEFAULT 1;
      ALTER TABLE attempts ADD COLUMN request_hash TEXT NOT NULL DEFAULT '';
      CREATE INDEX attempts_user_created_idx ON attempts(user_id, created_at);
      CREATE INDEX attempts_created_idx ON attempts(created_at);

      ALTER TABLE practice_sessions ADD COLUMN last_attempt_at INTEGER;

      CREATE TABLE login_guards (
        scope TEXT NOT NULL CHECK (scope IN ('ip', 'ip_account', 'account_risk')),
        guard_key TEXT NOT NULL,
        account_key TEXT,
        ip_address TEXT,
        window_started_at INTEGER NOT NULL,
        reservation_count INTEGER NOT NULL DEFAULT 0,
        failure_count INTEGER NOT NULL DEFAULT 0,
        blocked_until INTEGER,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY(scope, guard_key)
      ) STRICT;
      CREATE INDEX login_guards_account_idx ON login_guards(account_key, updated_at);
      CREATE INDEX login_guards_updated_idx ON login_guards(updated_at);
    `
  },
  {
    version: 3,
    sql: `
      ALTER TABLE users ADD COLUMN email TEXT COLLATE NOCASE;
      ALTER TABLE users ADD COLUMN email_verified_at INTEGER;
      CREATE UNIQUE INDEX users_email_unique_idx ON users(email COLLATE NOCASE) WHERE email IS NOT NULL;

      CREATE TABLE email_verification_codes (
        id TEXT PRIMARY KEY,
        email TEXT NOT NULL COLLATE NOCASE,
        purpose TEXT NOT NULL CHECK (purpose IN ('register', 'login', 'reset_password', 'bind_email')),
        user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
        user_auth_version INTEGER,
        code_hash TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        used_at INTEGER,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        request_ip TEXT,
        request_session_hash TEXT NOT NULL
      ) STRICT;
      CREATE INDEX email_codes_lookup_idx
        ON email_verification_codes(email COLLATE NOCASE, purpose, created_at DESC);
      CREATE INDEX email_codes_expiry_idx ON email_verification_codes(expires_at, used_at);

      CREATE TABLE email_auth_guards (
        scope TEXT NOT NULL CHECK (scope IN (
          'request_email', 'request_email_day', 'request_ip', 'request_pair',
          'verify_email', 'verify_ip', 'verify_pair', 'register_ip_day', 'bind_user_day'
        )),
        guard_key TEXT NOT NULL,
        window_started_at INTEGER NOT NULL,
        request_count INTEGER NOT NULL DEFAULT 0,
        blocked_until INTEGER,
        last_request_at INTEGER,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY(scope, guard_key)
      ) STRICT;
      CREATE INDEX email_auth_guards_updated_idx ON email_auth_guards(updated_at);

      CREATE TABLE email_send_daily (
        day_key TEXT PRIMARY KEY,
        send_count INTEGER NOT NULL DEFAULT 0,
        registration_send_count INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL
      ) STRICT;
    `
  }
];

function migrationChecksum(sql: string): string {
  return createHash("sha256").update(sql.replace(/\r\n/g, "\n").trim()).digest("hex");
}

export function openDatabase(config: Pick<AppConfig, "databasePath">): SqliteDatabase {
  if (config.databasePath !== ":memory:") mkdirSync(dirname(config.databasePath), { recursive: true, mode: 0o750 });
  const db = new Database(config.databasePath);
  if (config.databasePath !== ":memory:") chmodSync(config.databasePath, 0o600);
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("trusted_schema = OFF");
  return db;
}

export function migrateDatabase(db: SqliteDatabase): number {
  const latestVersion = Math.max(0, ...MIGRATIONS.map((migration) => migration.version));
  const migrationByVersion = new Map(MIGRATIONS.map((migration) => [migration.version, migration]));
  const tableExists = Boolean(
    db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'").get()
  );
  if (tableExists) {
    const versions = db.prepare("SELECT version FROM schema_migrations ORDER BY version").all() as Array<{ version: number }>;
    const unknown = versions.find((row) => row.version > latestVersion || !migrationByVersion.has(row.version));
    if (unknown) {
      throw new Error(`Database schema version ${unknown.version} is newer than or unknown to this server (latest ${latestVersion})`);
    }
    for (let index = 0; index < versions.length; index += 1) {
      if (versions[index]!.version !== index + 1) {
        throw new Error("Database migration history is not a contiguous prefix");
      }
    }
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      checksum TEXT NOT NULL,
      applied_at INTEGER NOT NULL
    ) STRICT;
  `);
  const columns = db.prepare("PRAGMA table_info(schema_migrations)").all() as Array<{ name: string }>;
  if (!columns.some((column) => column.name === "checksum")) {
    db.exec("ALTER TABLE schema_migrations ADD COLUMN checksum TEXT");
  }

  const appliedRows = db.prepare("SELECT version, checksum FROM schema_migrations ORDER BY version").all() as Array<{
    version: number;
    checksum: string | null;
  }>;
  const legacyChecksumUpgrade = appliedRows.length === 1 && appliedRows[0]!.version === 1 && appliedRows[0]!.checksum === null;
  const backfillLegacyChecksums = db.transaction(() => {
    for (const row of appliedRows) {
      const migration = migrationByVersion.get(row.version);
      if (!migration) throw new Error(`Unknown database schema version ${row.version}`);
      const expected = migrationChecksum(migration.sql);
      if (row.checksum === null) {
        if (!legacyChecksumUpgrade) throw new Error(`Missing migration checksum for version ${row.version}`);
        db.prepare("UPDATE schema_migrations SET checksum = ? WHERE version = ? AND checksum IS NULL").run(expected, row.version);
      } else if (row.checksum !== expected) {
        throw new Error(`Migration checksum mismatch for version ${row.version}`);
      }
    }
  });
  backfillLegacyChecksums();
  const applied = new Set(appliedRows.map((row) => row.version));
  const apply = db.transaction((migration: { version: number; sql: string }) => {
    db.exec(migration.sql);
    db.prepare("INSERT INTO schema_migrations(version, checksum, applied_at) VALUES (?, ?, ?)").run(
      migration.version,
      migrationChecksum(migration.sql),
      Date.now()
    );
  });
  for (const migration of MIGRATIONS) {
    if (!applied.has(migration.version)) apply(migration);
  }
  return latestVersion;
}

function locateContentSource(explicit?: string): string {
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const candidates = [explicit, resolve(process.cwd(), ".."), resolve(moduleDir, "../.."), process.cwd()].filter(
    (candidate): candidate is string => Boolean(candidate)
  );
  for (const candidate of candidates) {
    if (
      existsSync(resolve(candidate, "basic-english-850.md")) &&
      existsSync(resolve(candidate, "daily-english-high-frequency-sentences.md"))
    ) return candidate;
  }
  throw new Error("Could not locate the two Markdown content source files");
}

function readSeedContent(sourceDir: string): { parsed: ParsedContent; checksum: string } {
  const wordsSource = readFileSync(resolve(sourceDir, "basic-english-850.md"), "utf8");
  const sentencesSource = readFileSync(resolve(sourceDir, "daily-english-high-frequency-sentences.md"), "utf8");
  const words = parseWordMarkdown(wordsSource);
  const sentences = parseSentenceMarkdown(sentencesSource);
  if (words.items.length !== 850 || sentences.items.length !== 168) {
    throw new Error(`Seed integrity check failed: expected 850 words and 168 sentences, got ${words.items.length} and ${sentences.items.length}`);
  }
  return {
    parsed: { categories: [...words.categories, ...sentences.categories], items: [...words.items, ...sentences.items] },
    checksum: createHash("sha256").update(wordsSource).update("\0").update(sentencesSource).digest("hex")
  };
}

export interface SeedResult {
  categoriesInserted: number;
  itemsInserted: number;
  words: number;
  sentences: number;
}

function contentCounts(db: SqliteDatabase): { words: number; sentences: number; total: number } {
  const counts = db.prepare(`
    SELECT
      SUM(CASE WHEN kind = 'word' THEN 1 ELSE 0 END) AS words,
      SUM(CASE WHEN kind = 'sentence' THEN 1 ELSE 0 END) AS sentences,
      COUNT(*) AS total
    FROM items
  `).get() as { words: number | null; sentences: number | null; total: number };
  return { words: counts.words ?? 0, sentences: counts.sentences ?? 0, total: counts.total };
}

export function seedContent(db: SqliteDatabase, explicitSourceDir?: string): SeedResult {
  const completed = db.prepare("SELECT value FROM app_meta WHERE key = 'initial_seed_completed'").get() as
    | { value: string }
    | undefined;
  if (completed?.value === "1") {
    const counts = contentCounts(db);
    return { categoriesInserted: 0, itemsInserted: 0, words: counts.words, sentences: counts.sentences };
  }

  const legacyCounts = contentCounts(db);
  if (legacyCounts.total > 0) {
    if (legacyCounts.words !== 850 || legacyCounts.sentences !== 168) {
      throw new Error(
        `Cannot mark legacy seed complete: expected 850 words and 168 sentences, got ${legacyCounts.words} and ${legacyCounts.sentences}`
      );
    }
    db.transaction(() => {
      db.prepare("INSERT INTO app_meta(key, value) VALUES ('initial_seed_completed', '1')").run();
      db.prepare("INSERT INTO app_meta(key, value) VALUES ('initial_seed_checksum', 'legacy-v1')").run();
    })();
    return { categoriesInserted: 0, itemsInserted: 0, words: legacyCounts.words, sentences: legacyCounts.sentences };
  }

  const sourceDir = locateContentSource(explicitSourceDir);
  const { parsed, checksum } = readSeedContent(sourceDir);
  const now = Date.now();
  let categoriesInserted = 0;
  let itemsInserted = 0;
  const seed = db.transaction(() => {
    const insertCategory = db.prepare(`
      INSERT INTO categories(id, slug, name, kind, sort_order, status, created_at, updated_at, published_at)
      VALUES (?, ?, ?, ?, ?, 'published', ?, ?, ?)
      ON CONFLICT(slug) DO NOTHING
    `);
    for (const category of parsed.categories) {
      const result = insertCategory.run(randomUUID(), category.slug, category.name, category.kind, category.sortOrder, now, now, now);
      categoriesInserted += result.changes;
    }
    const categories = new Map(
      (db.prepare("SELECT id, slug FROM categories").all() as Array<{ id: string; slug: string }>).map((row) => [row.slug, row.id])
    );
    const insertItem = db.prepare(`
      INSERT INTO items(
        id, item_key, category_id, kind, english, meaning, pronunciation, normalized_answer,
        sort_order, revision, status, created_at, updated_at, published_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 'published', ?, ?, ?)
      ON CONFLICT(item_key) DO NOTHING
    `);
    const insertRevision = db.prepare(`
      INSERT INTO item_revisions(item_id, revision, action, snapshot_json, changed_by, created_at)
      VALUES (?, 1, 'seed', ?, NULL, ?)
    `);
    for (const item of parsed.items) {
      const categoryId = categories.get(item.categorySlug);
      if (!categoryId) throw new Error(`Missing seeded category ${item.categorySlug}`);
      const id = randomUUID();
      const result = insertItem.run(
        id,
        item.key,
        categoryId,
        item.kind,
        item.english,
        item.meaning,
        item.pronunciation,
        item.english.normalize("NFKC").replace(/[‘’]/g, "'").trim().replace(/\s+/g, " ").toLocaleLowerCase("en-US"),
        item.sortOrder,
        now,
        now,
        now
      );
      if (result.changes) {
        itemsInserted += 1;
        insertRevision.run(id, JSON.stringify(item), now);
      }
    }
    db.prepare("INSERT INTO app_meta(key, value) VALUES ('content_version', '1') ON CONFLICT(key) DO NOTHING").run();
    db.prepare("INSERT INTO app_meta(key, value) VALUES ('initial_seed_completed', '1')").run();
    db.prepare("INSERT INTO app_meta(key, value) VALUES ('initial_seed_checksum', ?)").run(checksum);
  });
  seed();
  return {
    categoriesInserted,
    itemsInserted,
    words: parsed.items.filter((item) => item.kind === "word").length,
    sentences: parsed.items.filter((item) => item.kind === "sentence").length
  };
}

export function migrateAndSeed(db: SqliteDatabase, explicitSourceDir?: string): SeedResult {
  migrateDatabase(db);
  return seedContent(db, explicitSourceDir);
}

export function bumpContentVersion(db: SqliteDatabase): string {
  const current = db.prepare("SELECT value FROM app_meta WHERE key = 'content_version'").get() as { value: string } | undefined;
  const next = String((Number(current?.value ?? "0") || 0) + 1);
  db.prepare(`
    INSERT INTO app_meta(key, value) VALUES ('content_version', ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(next);
  return next;
}

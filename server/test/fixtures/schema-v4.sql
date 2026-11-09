-- Frozen schema 4 from source commit f0344698faa04011d1e4a914454b91d82c2d5fc7.
-- This fixture intentionally does not read the current migration definitions.
CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, checksum TEXT NOT NULL, applied_at INTEGER NOT NULL) STRICT;

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

INSERT INTO schema_migrations(version, checksum, applied_at) VALUES (1, '6770b19d779f6c6b48ccf65b085b4dce4f97e206e333d95c29fc8a0d4e478b59', 1700000000001);

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

INSERT INTO schema_migrations(version, checksum, applied_at) VALUES (2, '539756f7cd47a04af2426f9c0b3180f5a31f1399fbfa3a4b63f912b4ffc6ce2f', 1700000000002);

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

INSERT INTO schema_migrations(version, checksum, applied_at) VALUES (3, '026d2344ee775e81e95752dce0f6e69deede249f1fa35cac9699a4882d04ecaf', 1700000000003);

ALTER TABLE import_previews ADD COLUMN format TEXT NOT NULL DEFAULT 'csv'
        CHECK (format IN ('csv', 'markdown'));

      CREATE TABLE import_batches (
        id TEXT PRIMARY KEY,
        created_by TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        source_preview_id TEXT NOT NULL UNIQUE,
        file_name TEXT NOT NULL,
        result_json TEXT NOT NULL,
        created_at INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX import_batches_owner_idx ON import_batches(created_by, created_at);

      CREATE TABLE import_batch_items (
        batch_id TEXT NOT NULL REFERENCES import_batches(id) ON DELETE CASCADE,
        item_id TEXT NOT NULL REFERENCES items(id),
        sort_order INTEGER NOT NULL,
        PRIMARY KEY(batch_id, item_id),
        UNIQUE(batch_id, sort_order)
      ) STRICT;

      ALTER TABLE practice_sessions ADD COLUMN import_batch_id TEXT REFERENCES import_batches(id);
      CREATE INDEX practice_sessions_batch_idx ON practice_sessions(import_batch_id);
      CREATE INDEX items_category_answer_idx ON items(category_id, normalized_answer);

INSERT INTO schema_migrations(version, checksum, applied_at) VALUES (4, '9f2fbdd5165859435b2ac6f96921af38ce1b0a34fd6c0683d808f70f65a35b61', 1700000000004);

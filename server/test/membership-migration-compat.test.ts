import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { migrateDatabase, openDatabase, type SqliteDatabase } from "../src/database.js";

// No membership, payment, application, or email feature modules are imported:
// the compatibility release must be able to run this migration by itself.
const schema4 = readFileSync(new URL("./fixtures/schema-v4.sql", import.meta.url), "utf8");
const createdAt = 1_700_000_000_000;
const day = 86_400_000;

function legacyInsert(db: SqliteDatabase, id: string, role = "user", at = createdAt): void {
  // Exactly the pre-membership insert shape, also used by legacy admin tools.
  db.prepare(`INSERT INTO users(id, username, display_name, password_hash, role, active,
    must_change_password, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, 0, ?, ?)`)
    .run(id, id, `Name ${id}`, `unchanged-hash-${id}`, role, at, at);
}

function snapshot(db: SqliteDatabase): Record<string, unknown[]> {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all() as Array<{ name: string }>;
  return Object.fromEntries(tables.map(({ name }) => [name,
    db.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}" ORDER BY rowid`).all()
  ]));
}

function seedRealSchema4(db: SqliteDatabase): void {
  db.exec(schema4);
  assert.equal((db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get() as { version: number }).version, 4);
  assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name = 'user_memberships'").get(), undefined);
  legacyInsert(db, "legacy-user");
  legacyInsert(db, "legacy-admin", "admin");
  legacyInsert(db, "legacy-disabled");
  db.exec(`
    UPDATE users SET email = 'legacy@example.test', email_verified_at = ${createdAt}, auth_version = 7 WHERE id = 'legacy-user';
    UPDATE users SET active = 0 WHERE id = 'legacy-disabled';
    INSERT INTO app_meta(key, value) VALUES ('content_version', 'preserve-existing-content-version');
    INSERT INTO categories(id,slug,name,kind,sort_order,status,created_at,updated_at,published_at)
      VALUES ('category','category','Original category','sentence',3,'published',${createdAt},${createdAt},${createdAt});
    INSERT INTO items(id,item_key,category_id,kind,english,meaning,normalized_answer,sort_order,revision,status,created_at,updated_at)
      VALUES ('item','item-key','category','sentence','Original answer.','原有释义','original answer.',2,4,'published',${createdAt},${createdAt});
    INSERT INTO item_revisions(item_id,revision,action,snapshot_json,changed_by,created_at)
      VALUES ('item',4,'update','{"original":true}','legacy-admin',${createdAt});
    INSERT INTO import_previews(id,created_by,category_id,payload_json,errors_json,row_count,created_at,expires_at,committed_at,format)
      VALUES ('preview','legacy-admin','category','{"private":"payload"}','[]',1,${createdAt},${createdAt + day},${createdAt},'markdown');
    INSERT INTO import_batches(id,created_by,source_preview_id,file_name,result_json,created_at)
      VALUES ('batch','legacy-admin','preview','private.md','{"created":1}',${createdAt});
    INSERT INTO import_batch_items(batch_id,item_id,sort_order) VALUES ('batch','item',0);
    INSERT INTO sessions(id_hash,csrf_token,csrf_hash,user_id,auth_version,created_at,last_seen_at,expires_at,absolute_expires_at)
      VALUES ('existing-session','existing-csrf','existing-csrf-hash','legacy-user',7,${createdAt},${createdAt},${createdAt + day},${createdAt + 7 * day});
    INSERT INTO practice_sessions(id,user_id,mode,category_id,started_at,total_attempts,correct_attempts,duration_ms)
      VALUES ('practice','legacy-user','sequential','category',${createdAt},3,2,12000);
    INSERT INTO attempts(id,client_attempt_id,practice_session_id,user_id,item_id,correct,first_try_correct,duration_ms,occurred_at,created_at,item_revision,request_hash)
      VALUES ('attempt','client-id','practice','legacy-user','item',0,0,4000,${createdAt},${createdAt},4,'existing-request-hash');
    INSERT INTO progress(user_id,item_id,attempt_count,correct_count,wrong_count,is_mistake,last_attempt_at,last_wrong_at,updated_at)
      VALUES ('legacy-user','item',3,2,1,1,${createdAt},${createdAt},${createdAt});
    INSERT INTO user_imports(user_id,import_kind,imported_at,imported_count)
      VALUES ('legacy-user','legacy_mistakes',${createdAt},1);
    INSERT INTO email_verification_codes(id,email,purpose,user_id,user_auth_version,code_hash,created_at,expires_at,attempt_count,request_session_hash)
      VALUES ('challenge','legacy@example.test','login','legacy-user',7,'existing-code-hash',${createdAt},${createdAt + 600000},2,'existing-session');
    INSERT INTO email_auth_guards(scope,guard_key,window_started_at,request_count,updated_at)
      VALUES ('request_email','guard',${createdAt},3,${createdAt});
    INSERT INTO email_send_daily(day_key,send_count,registration_send_count,updated_at)
      VALUES ('2023-11-14',12,4,${createdAt});
    INSERT INTO audit_log(actor_user_id,action,target_type,target_id,metadata_json,created_at)
      VALUES ('legacy-admin','content.updated','item','item','{"revision":4}',${createdAt});
  `);
}

test("real schema 4 upgrades additively; legacy accounts, sessions and private history survive reopening", () => {
  const directory = mkdtempSync(join(tmpdir(), "membership-schema-compat-"));
  const databasePath = join(directory, "app.db");
  let db: SqliteDatabase | undefined;
  try {
    db = openDatabase({ databasePath });
    seedRealSchema4(db);
    const previous = snapshot(db);

    assert.equal(migrateDatabase(db), 5);
    const migrated = snapshot(db);
    for (const [table, rows] of Object.entries(previous)) {
      if (table === "schema_migrations") assert.deepEqual(migrated[table]?.slice(0, 4), rows);
      else assert.deepEqual(migrated[table], rows, `${table} must remain byte-for-byte equivalent`);
    }
    assert.deepEqual(db.prepare(`SELECT user_id,access_kind,trial_started_at,trial_ends_at,paid_until
      FROM user_memberships ORDER BY user_id`).all(), ["legacy-admin", "legacy-disabled", "legacy-user"].map(user_id => ({
        user_id, access_kind: "legacy_free", trial_started_at: null, trial_ends_at: null, paid_until: null
      })));
    assert.deepEqual(migrated.payment_orders, []);
    assert.deepEqual(db.pragma("foreign_key_check"), []);

    const newAt = createdAt + 10 * day;
    legacyInsert(db, "new-compatible-user", "user", newAt);
    assert.deepEqual(db.prepare("SELECT * FROM user_memberships WHERE user_id = 'new-compatible-user'").get(), {
      user_id: "new-compatible-user", access_kind: "metered", trial_started_at: newAt,
      trial_ends_at: newAt + day, paid_until: null, updated_at: newAt
    });
    // Account/profile changes must not reissue a trial. Persisted credits and
    // payment markers must also survive a compatibility-release restart.
    db.exec(`UPDATE users SET display_name = 'Changed', password_hash = 'changed-hash', auth_version = 2,
      active = 0, updated_at = ${newAt + 1000} WHERE id = 'new-compatible-user';
      UPDATE user_memberships SET paid_until = ${newAt + 31 * day}, updated_at = ${newAt + 1000}
        WHERE user_id = 'new-compatible-user';
      INSERT INTO payment_orders(id,user_id,amount_fen,duration_days,provider_mode,app_id,seller_id,status,
        created_at,expires_at,paid_at,provider_trade_no,credited_until,updated_at)
      VALUES ('existing-payment','new-compatible-user',100,30,'live','1234567890123456','2088123456789012','paid',
        ${newAt},${newAt + 900000},${newAt + 1000},'existing-provider-trade',${newAt + 31 * day},${newAt + 1000});`);
    const beforeRestart = snapshot(db);
    db.close();
    db = openDatabase({ databasePath });
    assert.equal(migrateDatabase(db), 5);
    assert.equal(migrateDatabase(db), 5);
    assert.deepEqual(snapshot(db), beforeRestart);
    assert.equal((db.prepare("SELECT trial_ends_at FROM user_memberships WHERE user_id = 'new-compatible-user'").get() as { trial_ends_at: number }).trial_ends_at, newAt + day);
    assert.deepEqual(db.pragma("foreign_key_check"), []);
    assert.equal(db.pragma("integrity_check", { simple: true }), "ok");

    assert.throws(() => db!.transaction(() => {
      legacyInsert(db!, "rolled-back-user");
      throw new Error("registration failed");
    }).immediate(), /registration failed/);
    assert.equal(db.prepare("SELECT 1 FROM users WHERE id = 'rolled-back-user'").get(), undefined);
    assert.equal(db.prepare("SELECT 1 FROM user_memberships WHERE user_id = 'rolled-back-user'").get(), undefined);
  } finally {
    db?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("schema 5 migration failure rolls back its free-account backfill and trial trigger atomically", () => {
  const db = openDatabase({ databasePath: ":memory:" });
  try {
    seedRealSchema4(db);
    // A conflicting table must never leave a half-upgraded database.
    db.exec("CREATE TABLE payment_orders (existing_marker TEXT)");
    const before = snapshot(db);
    assert.throws(() => migrateDatabase(db), /payment_orders already exists/);
    assert.deepEqual(snapshot(db), before);
    assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE name IN ('user_memberships','users_start_membership_trial')").get(), undefined);
    assert.deepEqual(db.pragma("foreign_key_check"), []);
  } finally {
    db.close();
  }
});

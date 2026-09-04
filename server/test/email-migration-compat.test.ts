import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { migrateDatabase, openDatabase } from "../src/database.js";

test("migration 3 is additive and legacy user inserts remain valid", () => {
  const db = openDatabase({ databasePath: ":memory:" });
  try {
    assert.equal(migrateDatabase(db), 3);
    const columns = new Set(
      (db.prepare("PRAGMA table_info(users)").all() as Array<{ name: string }>).map((column) => column.name)
    );
    assert.ok(columns.has("email"));
    assert.ok(columns.has("email_verified_at"));
    for (const table of ["email_verification_codes", "email_auth_guards", "email_send_daily"]) {
      assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table));
    }

    const now = Date.now();
    const id = randomUUID();
    db.prepare(`
      INSERT INTO users(
        id, username, display_name, password_hash, role, active,
        must_change_password, created_at, updated_at
      ) VALUES (?, 'legacy.user', 'Legacy User', 'legacy-password-hash', 'user', 1, 1, ?, ?)
    `).run(id, now, now);
    const user = db.prepare("SELECT email, email_verified_at FROM users WHERE id = ?").get(id) as {
      email: string | null;
      email_verified_at: number | null;
    };
    assert.deepEqual(user, { email: null, email_verified_at: null });
  } finally {
    db.close();
  }
});

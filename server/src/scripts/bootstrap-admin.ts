import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { loadConfig } from "../config.js";
import { migrateAndSeed, openDatabase } from "../database.js";
import { hashPassword, validatePassword, validateUsername } from "../security.js";

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const username = validateUsername(argument("--username") ?? "admin");
const passwordFile = argument("--password-file");
if (!passwordFile) throw new Error("Usage: bootstrap-admin --username admin --password-file <path>");
const password = validatePassword(readFileSync(passwordFile, "utf8").replace(/\r?\n$/, ""));
const config = loadConfig();
const db = openDatabase(config);

try {
  migrateAndSeed(db, config.contentSourceDir);
  const activeAdmin = db.prepare("SELECT username FROM users WHERE role = 'admin' AND active = 1 LIMIT 1").get() as
    | { username: string }
    | undefined;
  if (activeAdmin) {
    process.stdout.write(`ADMIN_EXISTS username=${activeAdmin.username}\n`);
  } else {
    if (db.prepare("SELECT 1 FROM users WHERE username = ? COLLATE NOCASE").get(username)) {
      throw new Error(`Cannot bootstrap: username ${username} already exists but is not an active administrator`);
    }
    const passwordHash = await hashPassword(password);
    const now = Date.now();
    const id = randomUUID();
    db.transaction(() => {
      db.prepare(`
        INSERT INTO users(
          id, username, display_name, password_hash, role, active, must_change_password, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 'admin', 1, 1, ?, ?)
      `).run(id, username, username, passwordHash, now, now);
      db.prepare(`
        INSERT INTO audit_log(actor_user_id, action, target_type, target_id, metadata_json, created_at)
        VALUES (?, 'system.admin_bootstrapped', 'user', ?, ?, ?)
      `).run(id, id, JSON.stringify({ username }), now);
    })();
    process.stdout.write(`ADMIN_CREATED username=${username}\n`);
  }
} finally {
  db.close();
}

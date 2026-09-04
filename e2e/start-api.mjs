import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const runDir = mkdtempSync(join(tmpdir(), "english-typing-e2e-"));
const passwordFile = join(runDir, "admin-password");
const mailOutboxFile = join(tmpdir(), "english-typing-practice-e2e-mail-outbox-8091.jsonl");
const adminPassword = "E2eInitialAdmin!2026";
writeFileSync(passwordFile, `${adminPassword}\n`, { mode: 0o600 });
rmSync(mailOutboxFile, { force: true });

const databasePath = join(runDir, "app.db");

const env = {
  ...process.env,
  NODE_ENV: "test",
  HOST: "127.0.0.1",
  PORT: "8091",
  DATABASE_PATH: databasePath,
  APP_ORIGIN: "http://localhost:4173",
  CONTENT_SOURCE_DIR: root,
  GUEST_TOKEN_SECRET: "e2e-only-guest-token-secret-0123456789-abcdefghijklmnopqrstuvwxyz",
  EMAIL_CODE_SECRET: "e2e-only-email-code-secret-0123456789-abcdefghijklmnopqrstuvwxyz",
  EMAIL_DELIVERY: "test",
  EMAIL_TEST_OUTBOX_FILE: mailOutboxFile,
  EMAIL_SELF_REGISTRATION: "true",
  EMAIL_DAILY_SEND_LIMIT: "180",
  EMAIL_REGISTRATION_DAILY_SEND_LIMIT: "20",
  EMAIL_REGISTRATION_IP_DAILY_LIMIT: "10",
  TRUST_PROXY: "false",
  LOG_LEVEL: "silent"
};

function run(script, args = []) {
  const result = spawnSync(process.execPath, [join(root, "server", "dist", "scripts", script), ...args], {
    cwd: join(root, "server"),
    env,
    stdio: "inherit"
  });
  if (result.status !== 0) {
    rmSync(runDir, { recursive: true, force: true });
    process.exit(result.status ?? 1);
  }
}

run("migrate.js");
run("bootstrap-admin.js", ["--username", "admin", "--password-file", passwordFile]);
rmSync(passwordFile, { force: true });

const { openDatabase } = await import("../server/dist/database.js");
const { hashPassword } = await import("../server/dist/security.js");
const seedDatabase = openDatabase({ databasePath });
const insertEmailUser = seedDatabase.prepare(`
  INSERT INTO users(
    id, username, display_name, password_hash, role, active, must_change_password,
    created_at, updated_at, email, email_verified_at
  ) VALUES (?, ?, ?, ?, 'user', 1, 0, ?, ?, ?, ?)
`);
for (const fixture of [
  { username: "email.login", email: "email.login@example.com", password: "E2eEmailLogin!2026" },
  { username: "email.reset", email: "email.reset@example.com", password: "E2eEmailReset!2026" }
]) {
  const now = Date.now();
  insertEmailUser.run(
    randomUUID(),
    fixture.username,
    fixture.username,
    await hashPassword(fixture.password),
    now,
    now,
    fixture.email,
    now
  );
}
seedDatabase.close();

const api = spawn(process.execPath, [join(root, "server", "dist", "index.js")], {
  cwd: join(root, "server"),
  env,
  stdio: "inherit"
});

let stopping = false;
function stop(signal = "SIGTERM") {
  if (stopping) return;
  stopping = true;
  api.kill(signal);
}

process.once("SIGINT", () => stop("SIGINT"));
process.once("SIGTERM", () => stop("SIGTERM"));
api.once("exit", (code, signal) => {
  rmSync(mailOutboxFile, { force: true });
  rmSync(runDir, { recursive: true, force: true });
  if (!stopping && code !== 0) console.error(`E2E API exited unexpectedly: ${code ?? signal}`);
  process.exit(stopping ? 0 : (code ?? 1));
});

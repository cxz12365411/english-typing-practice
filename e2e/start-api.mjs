import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const runDir = mkdtempSync(join(tmpdir(), "english-typing-e2e-"));
const passwordFile = join(runDir, "admin-password");
const adminPassword = "E2eInitialAdmin!2026";
writeFileSync(passwordFile, `${adminPassword}\n`, { mode: 0o600 });

const env = {
  ...process.env,
  HOST: "127.0.0.1",
  PORT: "8091",
  DATABASE_PATH: join(runDir, "app.db"),
  APP_ORIGIN: "http://localhost:4173",
  CONTENT_SOURCE_DIR: root,
  GUEST_TOKEN_SECRET: "e2e-only-guest-token-secret-0123456789-abcdefghijklmnopqrstuvwxyz",
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
  rmSync(runDir, { recursive: true, force: true });
  if (!stopping && code !== 0) console.error(`E2E API exited unexpectedly: ${code ?? signal}`);
  process.exit(stopping ? 0 : (code ?? 1));
});

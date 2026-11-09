import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { buildApp } from "../src/app.js";
import { openDatabase } from "../src/database.js";
import { hashPassword } from "../src/security.js";

const resources = ["sentence-alignments.json", "cet4-writing.json", "cet6-writing.json"];
const origin = "https://resources.test";
const password = "Resource-access-test-123!";
function cookie(headers: Record<string, unknown>) {
  const raw = headers["set-cookie"];
  return String(Array.isArray(raw) ? raw[0] : raw).split(";")[0]!;
}

test("learning resources require current membership on every request and use the unchanged source", async () => {
  const db = openDatabase({ databasePath: ":memory:" });
  const sourceDir = fileURLToPath(new URL("../../", import.meta.url));
  const app = await buildApp({ database: db, seed: false, logger: false, config: {
    environment: "test", databasePath: ":memory:", appOrigin: origin,
    membershipEnabled: true, contentSourceDir: sourceDir
  } });
  try {
    const id = randomUUID(), now = Date.now();
    db.prepare(`INSERT INTO users(id,username,display_name,password_hash,role,active,must_change_password,created_at,updated_at)
      VALUES(?,?,?,?, 'user',1,0,?,?)`).run(id, "resource.user", "Resource", await hashPassword(password), now, now);
    const guest = await app.inject({ method: "GET", url: "/api/auth/session" });
    const login = await app.inject({ method: "POST", url: "/api/auth/login", headers: {
      cookie: cookie(guest.headers), origin, "x-csrf-token": guest.json().csrfToken
    }, payload: { username: "resource.user", password } });
    assert.equal(login.statusCode, 200, login.body);
    const headers = { cookie: cookie(login.headers) };
    for (const name of resources) {
      const url = `/api/content-resources/${name}`;
      assert.equal((await app.inject({ method: "GET", url })).statusCode, 401);
      const result = await app.inject({ method: "GET", url, headers });
      assert.equal(result.statusCode, 200, result.body);
      assert.equal(result.headers["cache-control"], "no-store");
      assert.deepEqual(result.json(), JSON.parse(readFileSync(path.join(sourceDir, name), "utf8")));
    }
    db.prepare("UPDATE user_memberships SET trial_started_at=?, trial_ends_at=? WHERE user_id=?").run(now - 86_400_001, now - 1, id);
    for (const name of resources) {
      const result = await app.inject({ method: "GET", url: `/api/content-resources/${name}`, headers });
      assert.equal(result.statusCode, 403);
      assert.equal(result.json().error.code, "MEMBERSHIP_REQUIRED");
    }
    assert.equal((await app.inject({ method: "GET", url: "/api/me/summary", headers })).statusCode, 200);
    db.prepare("UPDATE user_memberships SET access_kind='legacy_free' WHERE user_id=?").run(id);
    assert.equal((await app.inject({ method: "GET", url: `/api/content-resources/${resources[0]}`, headers })).statusCode, 200);
    db.prepare("UPDATE users SET active=0 WHERE id=?").run(id);
    assert.equal((await app.inject({ method: "GET", url: `/api/content-resources/${resources[0]}`, headers })).statusCode, 401);
  } finally { await app.close(); db.close(); }
});

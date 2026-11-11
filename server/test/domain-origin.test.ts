import assert from "node:assert/strict";
import test from "node:test";
import { buildApp } from "../src/app.js";
import { openDatabase } from "../src/database.js";
import { hashPassword } from "../src/security.js";

const OLD = "https://english.47.120.37.63.sslip.io";
const NEW = "https://cxzenglish.cn";
const PASSWORD = "Domain-Migration-Test-Only-123!";

test("registered-domain origin retains existing credentials and strict host-only sessions", async () => {
  const db = openDatabase({ databasePath: ":memory:" });
  const create = (appOrigin: string) => buildApp({ database: db, seed: false, logger: false,
    config: { environment: "test", appOrigin, guestTokenSecret: "domain-test-secret-longer-than-thirty-two-bytes" } });
  let app = await create(OLD);
  const now = Date.now();
  db.prepare(`INSERT INTO users(id,username,display_name,password_hash,role,active,must_change_password,created_at,updated_at)
    VALUES ('existing-user','existing.user','Existing user',?,'user',1,0,?,?)`)
    .run(await hashPassword(PASSWORD), now, now);
  try {
    for (const origin of [OLD, NEW]) {
      if (origin === NEW) { await app.close(); app = await create(NEW); }
      const guest = await app.inject({ method: "GET", url: "/api/auth/session" });
      const rawCookie = String(guest.headers["set-cookie"]);
      assert.match(rawCookie, /^__Host-etp_session=/);
      for (const attribute of ["Path=/", "HttpOnly", "Secure", "SameSite=Lax"]) assert.ok(rawCookie.includes(attribute));
      assert.ok(!rawCookie.includes("Domain="));
      const headers = { origin, cookie: rawCookie.split(";")[0]!, "x-csrf-token": guest.json().csrfToken };
      if (origin === NEW) {
        for (const rejectedOrigin of [OLD, "https://www.cxzenglish.cn", "https://untrusted.example"]) {
          const denied = await app.inject({ method: "POST", url: "/api/auth/login", headers: { ...headers, origin: rejectedOrigin }, payload: {} });
          assert.equal(denied.statusCode, 403);
          assert.equal(denied.json().error.code, "ORIGIN_INVALID");
        }
        const noCsrf = await app.inject({ method: "POST", url: "/api/auth/login", headers: { origin, cookie: headers.cookie }, payload: {} });
        assert.equal(noCsrf.json().error.code, "CSRF_INVALID");
      }
      const signed = await app.inject({ method: "POST", url: "/api/auth/login", headers, payload: { username: "existing.user", password: PASSWORD } });
      assert.equal(signed.statusCode, 200, signed.body);
      assert.equal(signed.json().user.id, "existing-user");
    }
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM users").get() as { n: number }).n, 1);
  } finally { await app.close(); db.close(); }
});

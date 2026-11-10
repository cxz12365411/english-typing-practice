import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import fsPromises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { buildApp } from "../src/app.js";
import { openDatabase } from "../src/database.js";
import { hashPassword } from "../src/security.js";

const origin = "https://speech.test";
const password = "speech-fixture-password-123!";
const english = "Would you like to exchange numbers?";
const digest = (text: string | Buffer) => createHash("sha256").update(text).digest("hex");
const textKey = digest(english);
const url = `/api/speech/audio/01/${textKey}?itemId=item`;

function cookie(headers: Record<string, unknown>): string {
  const raw = headers["set-cookie"];
  return String(Array.isArray(raw) ? raw[0] : raw).split(";")[0]!;
}

function bundle(root: string) {
  const voices = ["01", "02", "03", "04", "05"].map((id) => ({ id, name: `Voice ${id}` }));
  function asset(voiceId: string, prefix: "voices" | "previews", originalText: string) {
    const key = digest(originalText);
    const relative = `${prefix}/${voiceId}/${key}.mp3`;
    const bytes = Buffer.from(`ID3 fixture ${prefix} ${voiceId} ${originalText}`);
    mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
    writeFileSync(path.join(root, relative), bytes);
    return { textKey: key, originalText, spokenText: originalText, voiceId, path: relative,
      sha256: digest(bytes), duration: 3, sampleRate: 24000, format: "mp3", qaStatus: "passed" };
  }
  const manifest = { manifestVersion: 1, voices,
    assets: voices.map(({ id }) => asset(id, "voices", english)),
    previews: voices.map(({ id }) => asset(id, "previews", "Welcome to English practice.")) };
  writeFileSync(path.join(root, "manifest.json"), JSON.stringify(manifest));
  return manifest;
}

async function fixture(t: TestContext, options: {
  membershipEnabled?: boolean;
  mutate?: (root: string, manifest: ReturnType<typeof bundle>) => void;
  missing?: boolean;
  relative?: boolean;
  role?: "user" | "admin";
} = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "speech-test-"));
  const manifest = bundle(root);
  options.mutate?.(root, manifest);
  const db = openDatabase({ databasePath: ":memory:" });
  const app = await buildApp({ database: db, seed: false, logger: false, config: {
    environment: "test", appOrigin: origin, membershipEnabled: options.membershipEnabled ?? true,
    speechAudioDir: options.relative ? "relative/audio" : options.missing ? path.join(root, "missing") : root
  } });
  t.after(async () => { await app.close(); db.close(); rmSync(root, { recursive: true, force: true }); });
  const id = randomUUID(), now = Date.now();
  db.prepare(`INSERT INTO users(id,username,display_name,password_hash,role,active,must_change_password,created_at,updated_at)
    VALUES(?,?,?,?,?,1,0,?,?)`).run(id, "speech.user", "Speech user", await hashPassword(password), options.role ?? "user", now, now);
  db.prepare(`INSERT INTO categories(id,slug,name,kind,status,created_at,updated_at)
    VALUES ('category','category','Category','sentence','published',?,?)`).run(now, now);
  db.prepare(`INSERT INTO items(id,item_key,category_id,kind,english,meaning,normalized_answer,status,created_at,updated_at)
    VALUES ('item','item','category','sentence',?,'你愿意交换电话号码吗？',?,'published',?,?)`).run(english, english.toLowerCase(), now, now);
  const guest = await app.inject({ method: "GET", url: "/api/auth/session" });
  const login = await app.inject({ method: "POST", url: "/api/auth/login", headers: {
    cookie: cookie(guest.headers), origin, "x-csrf-token": guest.json().csrfToken
  }, payload: { username: "speech.user", password } });
  assert.equal(login.statusCode, 200, login.body);
  return { root, manifest, app, db, id, headers: { cookie: cookie(login.headers) } };
}

test("speech catalog, previews and audio require authentication and current practice entitlement", async (t) => {
  const { app, db, id, headers } = await fixture(t);
  const routes = ["/api/speech/catalog", "/api/speech/preview/01", url];
  for (const route of routes) assert.equal((await app.inject({ url: route })).statusCode, 401);
  assert.equal((await app.inject({ method: "HEAD", url })).statusCode, 401);
  const catalog = await app.inject({ url: routes[0]!, headers });
  assert.equal(catalog.statusCode, 200);
  assert.equal(catalog.headers["cache-control"], "no-store");
  assert.equal(catalog.json().available, true);
  assert.deepEqual(catalog.json().voices.map((v: { id: string }) => v.id), ["01", "02", "03", "04", "05"]);
  assert.deepEqual(catalog.json().entries, [{ itemId: "item", english, textKey, voiceIds: ["01", "02", "03", "04", "05"] }]);
  db.prepare("UPDATE user_memberships SET trial_ends_at=? WHERE user_id=?").run(Date.now() - 1, id);
  for (const route of routes) {
    const locked = await app.inject({ url: route, headers });
    assert.equal(locked.statusCode, 403);
    assert.equal(locked.json().error.code, "MEMBERSHIP_REQUIRED");
  }
  db.prepare("UPDATE user_memberships SET access_kind='legacy_free' WHERE user_id=?").run(id);
  assert.equal((await app.inject({ url, headers })).statusCode, 200);
  db.prepare("UPDATE users SET active=0 WHERE id=?").run(id);
  assert.equal((await app.inject({ url, headers })).statusCode, 401);
});

test("audio provides exact full, HEAD, suffix, bounded and open-ended byte range responses", async (t) => {
  const { app, headers, root, manifest } = await fixture(t);
  const bytes = readFileSync(path.join(root, manifest.assets[0]!.path));
  const full = await app.inject({ url, headers });
  assert.equal(full.statusCode, 200);
  assert.deepEqual(full.rawPayload, bytes);
  assert.equal(full.headers["content-type"], "audio/mpeg");
  assert.equal(full.headers["cache-control"], "no-store");
  assert.equal(full.headers["accept-ranges"], "bytes");
  const head = await app.inject({ method: "HEAD", url, headers });
  assert.equal(head.statusCode, 200);
  assert.equal(head.body, "");
  assert.equal(Number(head.headers["content-length"]), bytes.length);
  const partialHead = await app.inject({ method: "HEAD", url, headers: { ...headers, range: "bytes=2-6" } });
  assert.equal(partialHead.statusCode, 206);
  assert.equal(partialHead.body, "");
  assert.equal(Number(partialHead.headers["content-length"]), 5);
  for (const [range, start, end] of [["bytes=2-6", 2, 6], ["bytes=5-", 5, bytes.length - 1],
    ["bytes=-5", bytes.length - 5, bytes.length - 1], ["bytes=0-99999", 0, bytes.length - 1]] as const) {
    const response = await app.inject({ url, headers: { ...headers, range } });
    assert.equal(response.statusCode, 206);
    assert.equal(response.headers["content-range"], `bytes ${start}-${end}/${bytes.length}`);
    assert.deepEqual(response.rawPayload, bytes.subarray(start, end + 1));
  }
  for (const range of ["bytes=99999-", "bytes=5-2", "bytes=-0", "bytes=0-1,3-5", "bytes=-", "bytes=9007199254740993-"]) {
    const response = await app.inject({ url, headers: { ...headers, range } });
    assert.equal(response.statusCode, 416, range);
    assert.equal(response.headers["content-range"], `bytes */${bytes.length}`);
  }
  assert.equal((await app.inject({ url, headers: { ...headers, range: "bytes=0-1", "if-range": '"old"' } })).statusCode, 200);
  const preview = await app.inject({ url: "/api/speech/preview/05", headers });
  assert.equal(preview.statusCode, 200);
  assert.deepEqual(preview.rawPayload, readFileSync(path.join(root, manifest.previews[4]!.path)));
});

test("old URLs stop working immediately after text changes or item/category unpublishing", async (t) => {
  const { app, db, headers } = await fixture(t);
  for (const update of [
    "UPDATE items SET english='Changed English' WHERE id='item'",
    "UPDATE items SET status='archived' WHERE id='item'",
    "UPDATE categories SET status='draft' WHERE id='category'"
  ]) {
    db.prepare(update).run();
    assert.equal((await app.inject({ url, headers })).statusCode, 404);
    assert.deepEqual((await app.inject({ url: "/api/speech/catalog", headers })).json().entries, []);
    db.prepare("UPDATE items SET english=?, status='published' WHERE id='item'").run(english);
    db.prepare("UPDATE categories SET status='published' WHERE id='category'").run();
  }
  assert.equal((await app.inject({ url, headers })).statusCode, 200);
});

test("unknown voices, hashes, item IDs and traversal never become arbitrary file reads", async (t) => {
  const { app, headers } = await fixture(t);
  for (const route of [
    `/api/speech/audio/06/${textKey}?itemId=item`, `/api/speech/audio/01/${"a".repeat(64)}?itemId=item`,
    `/api/speech/audio/01/${textKey}`, `/api/speech/audio/01/${textKey}?itemId=private-item`,
    `/api/speech/audio/01/${textKey}?itemId=item&itemId=other`,
    `/api/speech/audio/01/${textKey}?itemId=../../manifest.json`,
    "/api/speech/audio/01/%2e%2e%2fmanifest.json?itemId=item", "/api/speech/preview/06"
  ]) assert.equal((await app.inject({ url: route, headers })).statusCode, 404, route);
});

test("missing or corrupted optional bundles preserve app availability and disable recorded voices", async (t) => {
  for (const kind of ["missing", "relative", "malformed", "path", "hash", "checksum", "missing-file", "symlink"] as const) {
    await t.test(kind, async (st) => {
      const { app, headers } = await fixture(st, {
        missing: kind === "missing", relative: kind === "relative",
        mutate(root, manifest) {
          const asset = manifest.assets[0]!;
          if (kind === "path") asset.path = "../outside.mp3";
          if (kind === "hash") asset.textKey = "b".repeat(64);
          if (kind === "checksum") asset.sha256 = "c".repeat(64);
          if (kind === "missing-file") unlinkSync(path.join(root, asset.path));
          if (kind === "symlink") {
            unlinkSync(path.join(root, asset.path));
            symlinkSync("/etc/hosts", path.join(root, asset.path));
          }
          writeFileSync(path.join(root, "manifest.json"), kind === "malformed" ? "invalid" : JSON.stringify(manifest));
        }
      });
      assert.deepEqual((await app.inject({ url: "/api/speech/catalog", headers })).json(), { available: false, voices: [], entries: [] });
      assert.equal((await app.inject({ url, headers })).statusCode, 404);
      assert.equal((await app.inject({ url: "/api/healthz" })).statusCode, 200);
      assert.equal((await app.inject({ url: "/api/content", headers })).statusCode, 200);
    });
  }
});

test("runtime tampering and deleted audio fail closed; no unchecked bytes are returned", async (t) => {
  const { app, root, manifest, headers } = await fixture(t);
  const filename = path.join(root, manifest.assets[0]!.path);
  writeFileSync(filename, "ID3 replaced wrong audio");
  assert.equal((await app.inject({ url, headers })).statusCode, 404);
  unlinkSync(filename);
  assert.equal((await app.inject({ url, headers })).statusCode, 404);
  symlinkSync("/etc/hosts", filename);
  assert.equal((await app.inject({ url, headers })).statusCode, 404);
});

test("review assets remain unavailable while the approved voices and temporary free access work", async (t) => {
  const { app, db, id, headers } = await fixture(t, { membershipEnabled: false,
    mutate(root, manifest) {
      manifest.assets[0]!.qaStatus = "review";
      unlinkSync(path.join(root, manifest.assets[0]!.path));
      writeFileSync(path.join(root, "manifest.json"), JSON.stringify(manifest));
    } });
  db.prepare("UPDATE user_memberships SET trial_ends_at=? WHERE user_id=?").run(Date.now() - 1, id);
  assert.equal((await app.inject({ url, headers })).statusCode, 404);
  assert.deepEqual((await app.inject({ url: "/api/speech/catalog", headers })).json().entries[0].voiceIds, ["02", "03", "04", "05"]);
  assert.equal((await app.inject({ url: url.replace("/01/", "/02/"), headers })).statusCode, 200);
});

test("revocation, disablement and entitlement changes during real file I/O withhold audio and previews", async (t) => {
  for (const route of [url, "/api/speech/preview/01"]) {
    for (const change of ["revoke", "disable", "demote", "reset", "password-required", "membership"] as const) {
      await t.test(`${route.includes("/preview/") ? "preview" : "audio"} ${change}`, async (st) => {
        const { app, db, id, headers } = await fixture(st, { role: change === "demote" ? "admin" : "user" });
        const originalOpen = fsPromises.open;
        let started!: () => void;
        let resume!: () => void;
        const opened = new Promise<void>((resolve) => { started = resolve; });
        const gate = new Promise<void>((resolve) => { resume = resolve; });
        // Read a real file; pause only after the OS has opened it, after request authentication.
        const patched = st.mock.method(fsPromises, "open", async (...args: Parameters<typeof originalOpen>) => {
          const handle = await originalOpen(...args);
          if (String(args[0]).endsWith(".mp3")) { started(); await gate; }
          return handle;
        });
        syncBuiltinESMExports();
        let pending: ReturnType<typeof app.inject> | undefined;
        let timeout: ReturnType<typeof setTimeout> | undefined;
        try {
          pending = app.inject({ url: route, headers });
          await Promise.race([opened, new Promise<never>((_, reject) => {
            timeout = setTimeout(() => reject(new Error("Audio read never began")), 3000);
          })]);
          if (change === "revoke") db.prepare("UPDATE sessions SET revoked_at=? WHERE user_id=?").run(Date.now(), id);
          if (change === "disable") db.prepare("UPDATE users SET active=0 WHERE id=?").run(id);
          if (change === "demote") db.prepare("UPDATE users SET role='user' WHERE id=?").run(id);
          if (change === "reset") db.prepare("UPDATE users SET auth_version=auth_version+1 WHERE id=?").run(id);
          if (change === "password-required") db.prepare("UPDATE users SET must_change_password=1 WHERE id=?").run(id);
          if (change === "membership") db.prepare("UPDATE user_memberships SET trial_ends_at=? WHERE user_id=?").run(Date.now() - 1, id);
          resume();
          const result = await pending;
          const expectedStatus = change === "password-required" || change === "membership" ? 403 : 409;
          assert.equal(result.statusCode, expectedStatus, result.body);
          assert.notEqual(result.headers["content-type"], "audio/mpeg");
          assert.equal(result.json().error.code, change === "password-required" ? "MUST_CHANGE_PASSWORD"
            : change === "membership" ? "MEMBERSHIP_REQUIRED" : "AUTH_STATE_CHANGED");
        } finally {
          clearTimeout(timeout);
          resume();
          await pending;
          patched.mock.restore();
          syncBuiltinESMExports();
        }
      });
    }
  }
});

import assert from "node:assert/strict";
import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { buildApp } from "../src/app.js";
import { openDatabase } from "../src/database.js";
import { hashPassword } from "../src/security.js";
import { amountToFen, createPaymentProvider, type PaymentProvider, type VerifiedPayment } from "../src/payment-provider.js";
import { loadPaymentConfig } from "../src/payment-config.js";

const ORIGIN = "https://english.test";
const APP_ID = "2026000000000001";
const SELLER_ID = "2088000000000001";
const DAY = 86_400_000;
const PASSWORD = "Payment-Student-123!";
class FakePayments implements PaymentProvider {
  readonly kind = "test" as const;
  readonly mode = "test" as const;
  readonly appId = APP_ID;
  readonly sellerId = SELLER_ID;
  queries = 0;
  event: VerifiedPayment | null = null;
  fail = false;
  beforeQuery: (() => Promise<void>) | undefined;
  paymentUrl(order: { id: string }): string { return `https://openapi-sandbox.dl.alipaydev.com/gateway.do?out_trade_no=${order.id}`; }
  verifyNotification(fields: Record<string, string>): VerifiedPayment | null {
    if (fields.sign !== "test-signature") return null;
    return { appId: fields.app_id!, sellerId: fields.seller_id!, orderId: fields.out_trade_no!,
      tradeNo: fields.trade_no!, amountFen: amountToFen(fields.total_amount) ?? -1,
      status: fields.trade_status === "TRADE_CLOSED" ? "closed" : "paid" };
  }
  async query(): Promise<VerifiedPayment | null> {
    this.queries++;
    await this.beforeQuery?.();
    if (this.fail) throw new Error("secret and raw buyer data must not escape");
    return this.event;
  }
}
function cookie(headers: Record<string, unknown>): string {
  const value = headers["set-cookie"];
  return String(Array.isArray(value) ? value[0] : value).split(";")[0]!;
}
async function fixture(payments: FakePayments | null = new FakePayments(), preview = false) {
  const db = openDatabase({ databasePath: ":memory:" });
  const app = await buildApp({ database: db, seed: false, logger: false,
    ...(payments ? { paymentProvider: payments } : {}),
    config: { environment: "test", databasePath: ":memory:", appOrigin: ORIGIN, membershipEnabled: !preview, paymentPreviewUserId: preview ? "preview-user" : undefined, payment: { mode: "disabled" } }
  });
  const passwordHash = await hashPassword(PASSWORD);
  async function client(name = randomUUID(), role = "user") {
    const id = preview && name === "student" ? "preview-user" : randomUUID(), now = Date.now();
    db.prepare(`INSERT INTO users(id,username,display_name,password_hash,role,active,must_change_password,created_at,updated_at)
      VALUES(?,?,?,?,?,1,0,?,?)`).run(id, name, "Test", passwordHash, role, now, now);
    const guest = await app.inject({ method: "GET", url: "/api/auth/session" });
    const login = await app.inject({ method: "POST", url: "/api/auth/login",
      headers: { cookie: cookie(guest.headers), origin: ORIGIN, "x-csrf-token": guest.json().csrfToken }, payload: { username: name, password: PASSWORD } });
    assert.equal(login.statusCode, 200, login.body);
    return { id, headers: { cookie: cookie(login.headers), origin: ORIGIN, "x-csrf-token": login.json().csrfToken } };
  }
  const user = await client("student");
  const create = (payload: unknown = {}) => app.inject({ method: "POST", url: "/api/payments/orders", headers: user.headers, payload });
  function notify(id: string, fields: Record<string, string> = {}) {
    const data = { app_id: APP_ID, seller_id: SELLER_ID, out_trade_no: id, trade_no: "202611090000000000001",
      total_amount: "1.00", trade_status: "TRADE_SUCCESS", sign: "test-signature", ...fields };
    return app.inject({ method: "POST", url: "/api/payments/alipay/notify", headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: new URLSearchParams(data).toString() });
  }
  return { app, db, user, client, create, notify, payments,
    async close() { await app.close(); db.close(); } };
}

test("payments stay disabled by default; forged amounts and exempt accounts cannot order", async () => {
  const f = await fixture(null);
  try {
    const disabled = await f.create();
    assert.equal(disabled.json().error.code, "PAYMENTS_DISABLED", disabled.body);
    const disabledNotify = await f.notify("ETnonexistent");
    assert.equal(disabledNotify.statusCode, 503); assert.equal(disabledNotify.body, "failure");
    assert.equal((await f.app.inject({ method: "GET", url: "/api/payments/orders" })).statusCode, 401);
  } finally { await f.close(); }
  const g = await fixture();
  try {
    assert.equal((await g.create({ planId: "monthly", amountFen: 1 })).statusCode, 422);
    assert.equal((await g.create({ planId: "yearly" })).statusCode, 422);
    g.db.prepare("UPDATE user_memberships SET access_kind='legacy_free' WHERE user_id=?").run(g.user.id);
    assert.equal((await g.create()).json().error.code, "MEMBERSHIP_NOT_REQUIRED");
    const admin = await g.client("admin", "admin");
    const result = await g.app.inject({ method: "POST", url: "/api/payments/orders", headers: admin.headers, payload: {} });
    assert.equal(result.json().error.code, "MEMBERSHIP_NOT_REQUIRED");
    assert.equal((g.db.prepare("SELECT COUNT(*) AS n FROM payment_orders").get() as { n: number }).n, 0);
  } finally { await g.close(); }
});

test("order reuse, ownership isolation, signature and merchant/amount checks, repeated and reordered callbacks", async () => {
  const f = await fixture();
  try {
    const first = await f.create(); assert.equal(first.statusCode, 201, first.body);
    const id = first.json().order.id;
    assert.equal((await f.create()).json().order.id, id);
    assert.equal(first.json().order.amountFen, 100);
    const another = await f.client("other");
    assert.equal((await f.app.inject({ method: "GET", url: `/api/payments/orders/${id}`, headers: another.headers })).statusCode, 404);
    for (const fields of [{ sign: "invalid" }, { total_amount: "0.01" }, { app_id: "another" }, { seller_id: "another" }]) {
      assert.equal((await f.notify(id, fields)).statusCode, 400);
    }
    const initial = f.db.prepare("SELECT trial_ends_at FROM user_memberships WHERE user_id=?").get(f.user.id) as { trial_ends_at: number };
    const responses = await Promise.all([f.notify(id), f.notify(id)]);
    for (const result of responses) assert.equal(result.body, "success", result.body);
    const paid = f.db.prepare("SELECT paid_until FROM user_memberships WHERE user_id=?").get(f.user.id) as { paid_until: number };
    assert.equal(paid.paid_until, initial.trial_ends_at + 30 * DAY);
    assert.equal((await f.notify(id, { trade_status: "TRADE_CLOSED" })).body, "success");
    assert.equal((f.db.prepare("SELECT paid_until FROM user_memberships WHERE user_id=?").get(f.user.id) as { paid_until: number }).paid_until, paid.paid_until);
    assert.equal((await f.notify(id, { trade_no: "202611090000000000002" })).statusCode, 400);
    const next = await f.create(); const nextId = next.json().order.id;
    assert.notEqual(id, nextId);
    assert.equal((await f.notify(nextId)).statusCode, 400, "same provider transaction cannot credit another order");
    assert.equal((await f.notify(nextId, { trade_no: "202611090000000000002" })).body, "success");
    assert.equal((f.db.prepare("SELECT paid_until FROM user_memberships WHERE user_id=?").get(f.user.id) as { paid_until: number }).paid_until, paid.paid_until + 30 * DAY);
  } finally { await f.close(); }
});

test("query compensation is throttled and concurrent with callbacks without double credit; timeouts still reconcile", async () => {
  const f = await fixture();
  try {
    const id = (await f.create()).json().order.id;
    const get = () => f.app.inject({ method: "GET", url: `/api/payments/orders/${id}`, headers: f.user.headers });
    await Promise.all([get(), get(), get()]); assert.equal(f.payments!.queries, 1);
    f.db.prepare("UPDATE payment_orders SET expires_at=?,last_checked_at=NULL WHERE id=?").run(Date.now() - DAY, id);
    f.payments!.event = { appId: APP_ID, sellerId: SELLER_ID, orderId: id, tradeNo: "202611090000000000001", amountFen: 100, status: "paid" };
    await Promise.all([get(), f.notify(id)]);
    const final = (await get()).json();
    assert.equal(final.order.status, "paid"); assert.equal(final.paymentUrl, null);
    assert.equal((f.db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action='membership.payment_credited'").get() as { n: number }).n, 1);
    const nextId = (await f.create()).json().order.id;
    f.payments!.fail = true;
    const error = await f.app.inject({ method: "GET", url: `/api/payments/orders/${nextId}`, headers: f.user.headers });
    assert.equal(error.statusCode, 503); assert.ok(!error.body.includes("secret"));
  } finally { await f.close(); }
});

test("notification endpoint rejects JSON and duplicate fields; browser endpoints retain origin and CSRF enforcement", async () => {
  const f = await fixture();
  try {
    const id = (await f.create()).json().order.id;
    assert.equal((await f.app.inject({ method: "POST", url: "/api/payments/alipay/notify", payload: {} })).statusCode, 415);
    assert.equal((await f.app.inject({ method: "POST", url: "/api/payments/alipay/notify", headers: { "content-type": "application/x-www-form-urlencoded" }, payload: "sign=x&sign=y" })).statusCode, 400);
    assert.equal((await f.app.inject({ method: "POST", url: "/api/payments/orders", headers: { cookie: f.user.headers.cookie }, payload: {} })).statusCode, 403);
    assert.equal((await f.app.inject({ method: "POST", url: "/api/payments/orders", headers: { cookie: f.user.headers.cookie, origin: ORIGIN }, payload: {} })).statusCode, 403);
    for (const url of ["/api/payments/alipay/notify/extra", "/api/payments/alipay/notify%2Fextra",
      "/api/payments/orders?next=/api/payments/alipay/notify"]) {
      const rejected = await f.app.inject({ method: "POST", url, payload: {} });
      assert.equal(rejected.statusCode, 403, `${url}: ${rejected.body}`);
      assert.equal(rejected.json().error.code, "ORIGIN_INVALID");
    }
    assert.equal((await f.notify(id)).statusCode, 200);
  } finally { await f.close(); }
});

test("revocation during query keeps confirmed payment but withholds the order response", async () => {
  const f = await fixture();
  try {
    const id = (await f.create()).json().order.id;
    let started!: () => void, release!: () => void;
    const queried = new Promise<void>(resolve => { started = resolve; });
    const resume = new Promise<void>(resolve => { release = resolve; });
    f.payments!.beforeQuery = async () => { started(); await resume; };
    f.payments!.event = { appId: APP_ID, sellerId: SELLER_ID, orderId: id, tradeNo: "202611090000000000001", amountFen: 100, status: "paid" };
    const checking = f.app.inject({ method: "GET", url: `/api/payments/orders/${id}`, headers: f.user.headers });
    await queried;
    f.db.prepare("UPDATE users SET active=0 WHERE id=?").run(f.user.id);
    release();
    const response = await checking;
    assert.equal(response.statusCode, 409, response.body);
    assert.equal(response.json().error.code, "AUTH_STATE_CHANGED");
    assert.ok(!response.body.includes("paymentUrl"));
    assert.equal((f.db.prepare("SELECT status FROM payment_orders WHERE id=?").get(id) as { status: string }).status, "paid");
    assert.ok((f.db.prepare("SELECT paid_until FROM user_memberships WHERE user_id=?").get(f.user.id) as { paid_until: number }).paid_until > Date.now());
  } finally { await f.close(); }
});

test("order creation quota persists and closed orders can reconcile a verified late payment", async () => {
  const f = await fixture();
  try {
    let firstId = "";
    for (let i = 0; i < 10; i++) {
      const result = await f.create(); assert.equal(result.statusCode, 201, result.body);
      const id = result.json().order.id;
      if (!firstId) firstId = id;
      f.db.prepare("UPDATE payment_orders SET status='closed' WHERE id=?").run(id);
    }
    const limited = await f.create();
    assert.equal(limited.statusCode, 429);
    assert.equal(limited.json().error.code, "PAYMENT_RATE_LIMITED");
    assert.equal((await f.notify(firstId)).body, "success");
    const order = await f.app.inject({ method: "GET", url: `/api/payments/orders/${firstId}`, headers: f.user.headers });
    assert.equal(order.json().order.status, "paid");
    const list = await f.app.inject({ method: "GET", url: "/api/payments/orders", headers: f.user.headers });
    assert.equal(list.json().orders.length, 10);
    assert.ok(!list.body.includes("seller_id"));
    assert.ok(!list.body.includes("provider_trade_no"));
  } finally { await f.close(); }
});

test("RSA2 notification verification and signed official cashier URL bind merchant, amount and return destination", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "english-payments-"));
  const merchant = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const alipay = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const privateKeyPath = path.join(directory, "merchant.pem"), alipayPublicKeyPath = path.join(directory, "alipay.pem");
  writeFileSync(privateKeyPath, merchant.privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
  writeFileSync(alipayPublicKeyPath, alipay.publicKey.export({ type: "spki", format: "pem" }), { mode: 0o600 });
  try {
    const config = { mode: "sandbox" as const, appId: APP_ID, sellerId: SELLER_ID, privateKeyPath, alipayPublicKeyPath };
    const provider = createPaymentProvider(config, ORIGIN, "test");
    const cashier = new URL(provider.paymentUrl({ id: "ETtestorder", amountFen: 100, expiresAt: Date.now() + 900_000 }));
    assert.equal(cashier.origin, "https://openapi-sandbox.dl.alipaydev.com");
    assert.equal(cashier.searchParams.get("method"), "alipay.trade.page.pay");
    assert.equal(cashier.searchParams.get("return_url"), `${ORIGIN}/membership?order=ETtestorder`);
    assert.equal(cashier.searchParams.get("notify_url"), `${ORIGIN}/api/payments/alipay/notify`);
    const biz = JSON.parse(cashier.searchParams.get("biz_content")!);
    assert.equal(biz.total_amount, "1.00"); assert.equal(biz.seller_id, SELLER_ID);
    const fields: Record<string, string> = { sign_type: "RSA2", app_id: APP_ID, seller_id: SELLER_ID,
      out_trade_no: "ETtestorder", trade_no: "202611090000000000001", total_amount: "1.00",
      trade_status: "TRADE_SUCCESS", notify_type: "trade_status_sync", subject: "会员 + % 中文" };
    const signFields = () => {
      const text = Object.keys(fields).filter(key => key !== "sign" && key !== "sign_type").sort().map(key => `${key}=${fields[key]}`).join("&");
      fields.sign = sign("RSA-SHA256", Buffer.from(text), alipay.privateKey).toString("base64");
    };
    signFields(); assert.equal(provider.verifyNotification(fields)?.amountFen, 100);
    fields.total_amount = "2.00"; assert.equal(provider.verifyNotification(fields), null);
    signFields(); assert.equal(provider.verifyNotification(fields)?.amountFen, 200, "amount approval belongs to stored order validation");
    fields.seller_id = "2088000000000002"; signFields(); assert.equal(provider.verifyNotification(fields), null);
    const originalFetch = globalThis.fetch;
    try {
      const queryData = { code: "10000", out_trade_no: "ETtestorder", trade_no: "202611090000000000001",
        total_amount: "1.00", trade_status: "TRADE_SUCCESS" };
      const querySignature = sign("RSA-SHA256", Buffer.from(JSON.stringify(queryData)), alipay.privateKey).toString("base64");
      let transportBody = JSON.stringify({ alipay_trade_query_response: queryData, sign: querySignature });
      globalThis.fetch = async (url, init) => {
        assert.equal(String(url), "https://openapi-sandbox.dl.alipaydev.com/gateway.do");
        assert.equal(init?.redirect, "error");
        assert.equal(init?.method, "POST");
        assert.ok(init?.signal);
        const parameters = init?.body as URLSearchParams;
        assert.equal(parameters.get("method"), "alipay.trade.query");
        assert.equal(parameters.get("app_id"), APP_ID);
        assert.ok(parameters.get("sign"));
        return new Response(transportBody, { status: 200 });
      };
      assert.equal((await provider.query("ETtestorder"))?.status, "paid");
      transportBody = JSON.stringify({ alipay_trade_query_response: { ...queryData, total_amount: "2.00" }, sign: querySignature });
      await assert.rejects(provider.query("ETtestorder"), /验签/);
      transportBody = JSON.stringify({ alipay_trade_query_response: queryData });
      await assert.rejects(provider.query("ETtestorder"), /Unsigned/);
      transportBody = "x".repeat(131_073);
      await assert.rejects(provider.query("ETtestorder"), /too large/);
    } finally { globalThis.fetch = originalFetch; }
    assert.throws(() => createPaymentProvider(config, ORIGIN, "production"), /Sandbox/);
    assert.throws(() => createPaymentProvider({ ...config, mode: "live" }, ORIGIN, "test"), /production/);
    assert.throws(() => createPaymentProvider({ ...config, mode: "live" }, ORIGIN, "production"), /protected/);
    chmodSync(privateKeyPath, 0o660);
    assert.throws(() => createPaymentProvider(config, ORIGIN, "test"), /protected/);
    chmodSync(privateKeyPath, 0o604);
    assert.throws(() => createPaymentProvider(config, ORIGIN, "test"), /protected/);
    chmodSync(privateKeyPath, 0o600);
    const linkPath = path.join(directory, "linked-private.pem");
    symlinkSync(privateKeyPath, linkPath);
    assert.throws(() => createPaymentProvider({ ...config, privateKeyPath: linkPath }, ORIGIN, "test"), /protected/);
    chmodSync(alipayPublicKeyPath, 0o664);
    assert.throws(() => createPaymentProvider(config, ORIGIN, "test"), /protected/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("payment configuration and money parsing fail closed", () => {
  assert.deepEqual(loadPaymentConfig({}, "production"), { mode: "disabled" });
  assert.throws(() => loadPaymentConfig({ PAYMENT_MODE: "test" }, "production"));
  assert.throws(() => loadPaymentConfig({ PAYMENT_MODE: "sandbox" }, "production"));
  assert.throws(() => loadPaymentConfig({ PAYMENT_MODE: "live" }, "test"));
  for (const value of ["1e0", "1.001", " 1.00", "-1", 1, null]) assert.equal(amountToFen(value), null);
  assert.equal(amountToFen("1.00"), 100); assert.equal(amountToFen("1"), 100);
});


test("payment preview is limited to one ordinary account without locking practice", async () => {
  const f = await fixture(new FakePayments(), true);
  try {
    f.db.prepare("UPDATE user_memberships SET trial_started_at=0, trial_ends_at=1 WHERE user_id=?").run(f.user.id);
    const member = (await f.app.inject({method:"GET",url:"/api/membership",headers:f.user.headers})).json();
    assert.equal(member.enabled,true);
    assert.equal(member.paymentEnabled,true);
    assert.equal(member.access.canPractice,true);
    const order = await f.create();
    assert.equal(order.statusCode,201);
    assert.ok(order.json().paymentUrl);
    const other = await f.client("not-preview");
    const ordinary = (await f.app.inject({method:"GET",url:"/api/membership",headers:other.headers})).json();
    assert.equal(ordinary.enabled,false);
    assert.equal(ordinary.paymentEnabled,false);
    assert.equal(ordinary.access.canPractice,true);
    assert.equal((await f.app.inject({method:"POST",url:"/api/payments/orders",headers:other.headers,payload:{}})).statusCode,503);
    assert.equal((await f.app.inject({method:"GET",url:"/api/payments/orders/"+order.json().order.id,headers:other.headers})).statusCode,404);
    f.db.prepare("UPDATE user_memberships SET access_kind='legacy_free' WHERE user_id=?").run(f.user.id);
    assert.equal((await f.create()).json().error.code,"MEMBERSHIP_NOT_REQUIRED");
  } finally { await f.close(); }
});

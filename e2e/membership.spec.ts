import { mkdirSync, readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";

const user = { id: "member", username: "u_internal123", displayName: "英语学习者", role: "user", status: "active", mustChangePassword: false, email: "member@example.com", emailVerified: true, createdAt: new Date().toISOString() };
const category = { id: "words", name: "测试单词", kind: "word", sortOrder: 0 };
const item = { id: "apple", key: "apple", english: "apple", meaning: "苹果", pronunciation: "", categoryId: "words", kind: "word", revision: 1, sortOrder: 0 };
async function mock(page: Page, options: { status?: string; enabled?: boolean; payment?: boolean; anonymous?: boolean } = {}) {
  let status = options.status ?? "trial";
  let signedIn = !options.anonymous;
  let paid = false;
  let pendingStatus = "pending";
  let expireAttempt = false;
  let expireAfterCorrect = false;
  const calls: string[] = [];
  let registered: unknown;
  const member = () => ({ enabled: options.enabled !== false, access: { status, canPractice: options.enabled === false || status !== "expired", trialEndsAt: new Date(Date.now() + 86_400_000).toISOString(), paidUntil: paid ? new Date(Date.now() + 30 * 86_400_000).toISOString() : null, expiresAt: new Date(Date.now() + 86_400_000).toISOString() }, plan: { id: "monthly", priceFen: 100, durationDays: 30 }, paymentEnabled: Boolean(options.payment), paymentMode: options.payment ? "sandbox" : "disabled" });
  const capabilities = { emailAuthEnabled: true, selfRegistrationEnabled: true, membershipEnabled: options.enabled !== false };
  const order = () => ({ id: "order-test-1", status: paid ? "paid" : pendingStatus, amountFen: 100, durationDays: 30, createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 900_000).toISOString(), paidAt: paid ? new Date().toISOString() : null, creditedUntil: paid ? new Date(Date.now() + 30 * 86_400_000).toISOString() : null });
  await page.route("**/api/**", async route => {
    const path = new URL(route.request().url()).pathname;
    calls.push(path);
    const send = (body: unknown, statusCode = 200) => route.fulfill({ status: statusCode, contentType: "application/json", body: JSON.stringify(body) });
    if (path === "/api/auth/session") return send({ user: signedIn ? user : null, csrfToken: "csrf", capabilities });
    if (path === "/api/auth/email/request-code") return send({ ok: true, challengeId: "11111111-1111-4111-8111-111111111111", retryAfterSeconds: 1 });
    if (path === "/api/auth/email/register") { registered = route.request().postDataJSON(); signedIn = true; return send({ user, csrfToken: "csrf", capabilities }); }
    if (path === "/api/membership") return send(member());
    if (path === "/api/me/summary") return send({ totals: { sessions: 4, attempts: 12, correct: 10, mistakes: 2 }, recentSessions: [] });
    if (path === "/api/payments/orders" && route.request().method() === "GET") return send({ orders: paid ? [order()] : [] });
    if (path.startsWith("/api/payments/orders")) return send({ order: order(), paymentUrl: paid ? null : "https://openapi-sandbox.dl.alipaydev.com/gateway.do?test=1", paymentMode: "sandbox", retryAfterSeconds: 5 });
    if (path === "/api/content") return send({ categories: [category], items: [item, { ...item, id: "banana", key: "banana", english: "banana", sortOrder: 1 }], version: 1 });
    if (path.startsWith("/api/content-resources/")) return send(JSON.parse(readFileSync(path.split("/").pop()!, "utf8")));
    if (path === "/api/me/mistakes") return send({ items: [], locked: status === "expired", total: 2 });
    if (path === "/api/practice/sessions") return send({ session: { id: "session-1", startedAt: new Date().toISOString() } });
    if (path.endsWith("/finish")) return send({ ok: true });
    if (path.endsWith("/attempts")) { if (expireAttempt) { status = "expired"; return send({ error: { code: "MEMBERSHIP_REQUIRED", message: "Expired" } }, 403); } const correct = route.request().postDataJSON().answer === "apple"; if (correct && expireAfterCorrect) status = "expired"; return send({ correct, summary: {} }); }
    if (path === "/api/me/profile") return send({ user: { ...user, displayName: route.request().postDataJSON().displayName } });
    return send({ error: { code: "NOT_FOUND", message: path } }, 404);
  });
  return { calls, registered: () => registered, expire: () => { expireAttempt = true; }, pay: () => { paid = true; status = "active"; expireAttempt = false; }, setOrderStatus: (value: string) => { pendingStatus = value; }, expireAfterCorrect: () => { expireAfterCorrect = true; } };
}

test("email registration only requires verified email and code", async ({ page }) => {
  const control = await mock(page, { anonymous: true });
  await page.goto("/login");
  await page.getByRole("tab", { name: "注册账号" }).click();
  const form = page.locator("#registerForm");
  await expect(form).toContainText("24 小时试用");
  await expect(form.locator('[name="password"], [name="username"]')).toHaveCount(0);
  await form.locator('[name="email"]').fill("member@example.com");
  await form.getByRole("button", { name: "发送验证码" }).click();
  await expect(page.locator("#registerChallengeId")).toHaveValue(/11111111/);
  await form.locator('[name="code"]').fill("123456");
  await form.getByRole("button", { name: "注册并登录" }).click();
  await expect(page.locator("#answerInput")).toBeEnabled();
  expect(control.registered()).toEqual({ email: "member@example.com", code: "123456", challengeId: "11111111-1111-4111-8111-111111111111" });
});

test("expired mobile users retain records and account controls without loading exercises", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  const control = await mock(page, { status: "expired" });
  await page.goto("/practice");
  await expect(page.locator("#membershipStatus")).toHaveText("试用或会员已到期");
  await expect(page).toHaveURL(/\/membership$/);
  await expect(page.locator("#createMembershipOrder")).toBeDisabled();
  await expect(page.getByRole("heading", { name: "学习记录" })).toBeVisible();
  await page.getByText("账号安全与邮箱", { exact: true }).click();
  await expect(page.locator("#emailPasswordForm")).toBeVisible();
  await page.locator('#profileForm [name="displayName"]').fill("新的昵称");
  await page.getByRole("button", { name: "保存昵称" }).click();
  await expect(page.locator("#profileMessage")).toHaveText("昵称已保存");
  mkdirSync("out/membership-preview", { recursive: true });
  await page.screenshot({ path: "out/membership-preview/expired-mobile.png", fullPage: true });
  expect(control.calls).not.toContain("/api/content");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
});

test("return page cannot unlock membership until the backend confirms payment", async ({ page }) => {
  const control = await mock(page, { status: "expired", payment: true });
  await page.goto("/membership?order=order-test-1&status=paid");
  await expect(page.locator("#paymentOrder")).toContainText("等待付款");
  await expect(page.locator("#membershipStatus")).toHaveText("试用或会员已到期");
  await expect(page.locator("#membershipOffer")).toContainText("测试支付环境");
  await expect(page.getByRole("link", { name: "前往支付宝扫码支付" })).toHaveAttribute("href", /^https:\/\/openapi-sandbox\.dl\.alipaydev\.com\//);
  mkdirSync("out/membership-preview", { recursive: true });
  await page.screenshot({ path: "out/membership-preview/checkout-desktop.png", fullPage: true });
  control.pay();
  await page.getByRole("button", { name: "刷新状态", exact: true }).click();
  await expect(page.locator("#membershipStatus")).toHaveText("会员有效");
  await expect(page.locator("#paymentOrder")).toContainText("支付成功");
  await page.getByRole("button", { name: "返回练习" }).click();
  await expect(page.locator("#answerInput")).toBeEnabled();
});

test("expiration while typing preserves input and offers renewal rather than network retry", async ({ page }) => {
  const control = await mock(page);
  await page.goto("/practice");
  await expect(page.locator("#answerInput")).toBeEnabled();
  control.expire();
  await page.locator("#answerInput").fill("my unfinished answer");
  await page.locator("#answerInput").press("Enter");
  await expect(page.locator("#answerInput")).toBeDisabled();
  await expect(page.locator("#answerInput")).toHaveValue("my unfinished answer");
  await expect(page.locator("#syncMessage")).toContainText("当前输入保留");
  await expect(page.locator("#retrySyncButton")).toBeHidden();
  await expect(page.locator("#speakButton")).toBeDisabled();
  control.pay();
  await page.getByRole("button", { name: "核实会员状态" }).click();
  await expect(page.locator("#answerInput")).toBeEnabled();
  await expect(page.locator("#answerInput")).toHaveValue("my unfinished answer");
  await expect(page.locator("#syncStrip")).toBeHidden();
});

test("disabled rollout and legacy accounts do not advertise a paid trial", async ({ page }) => {
  await mock(page, { enabled: false });
  await page.goto("/membership");
  await expect(page.locator("#membershipStatus")).toHaveText("当前免费开放");
  await expect(page.locator("#createMembershipOrder")).toBeHidden();
  await expect(page.locator(".membership-page")).not.toContainText("24 小时");
});


test("legacy accounts never have a purchase button when memberships are enabled", async ({ page }) => {
  await mock(page, { status: "legacy_free", payment: true });
  await page.goto("/membership");
  await expect(page.locator("#membershipStatus")).toHaveText("原有账号 · 持续免费");
  await expect(page.locator("#createMembershipOrder")).toBeHidden();
  await expect(page.getByRole("button", { name: "返回练习" })).toBeVisible();
});

test("expired or closed checkout can still be reconciled after a late confirmed payment", async ({ page }) => {
  const control = await mock(page, { status: "expired", payment: true });
  control.setOrderStatus("expired");
  await page.goto("/membership?order=order-test-1");
  await expect(page.locator("#paymentOrder")).toContainText("支付链接已过期");
  await expect(page.getByRole("link", { name: "前往支付宝扫码支付" })).toHaveCount(0);
  control.pay();
  await page.getByRole("button", { name: "刷新状态", exact: true }).click();
  await expect(page.locator("#membershipStatus")).toHaveText("会员有效");
  await expect(page.locator("#paymentOrder")).toContainText("支付成功");
});

test("leaving membership disposes its order polling", async ({ page }) => {
  const control = await mock(page, { status: "trial", payment: true });
  await page.goto("/membership?order=order-test-1");
  await expect(page.locator("#paymentOrder")).toContainText("等待付款");
  await page.getByRole("link", { name: "练习", exact: true }).click();
  await expect(page.locator("#answerInput")).toBeEnabled();
  const before = control.calls.filter(path => path.includes("/payments/orders/")).length;
  await page.waitForTimeout(5500);
  expect(control.calls.filter(path => path.includes("/payments/orders/")).length).toBe(before);
});


test("expiration during delayed advancement resumes the next item exactly once after renewal", async ({ page }) => {
  const control = await mock(page, { payment: true });
  await page.goto("/practice");
  await expect(page.locator("#answerInput")).toBeEnabled();
  control.expireAfterCorrect();
  await page.locator("#answerInput").fill("apple");
  await expect(page.locator("#syncMessage")).toContainText("当前输入保留");
  await page.waitForTimeout(700);
  await expect(page.locator("#targetWord")).toHaveText("apple");
  control.pay();
  await page.getByRole("button", { name: "核实会员状态" }).click();
  await expect(page.locator("#targetWord")).toHaveText("banana");
  await expect(page.locator("#answerInput")).toBeEnabled();
  expect(control.calls.filter(path => path.endsWith("/attempts"))).toHaveLength(1);
});


test("refreshing state cannot enable duplicate checkout creation while an order is pending", async ({ page }) => {
  const control = await mock(page, { status: "expired", payment: true });
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let started = false;
  await page.route("**/api/payments/orders", async route => {
    if (route.request().method() !== "POST") return route.fallback();
    started = true;
    await gate;
    await route.fallback();
  });
  await page.goto("/membership");
  await page.locator("#createMembershipOrder").click();
  await expect.poll(() => started).toBeTruthy();
  await page.getByRole("button", { name: "刷新状态", exact: true }).click();
  await expect(page.locator("#createMembershipOrder")).toBeDisabled();
  release();
  await expect(page.locator("#paymentOrder")).toContainText("等待付款");
  await expect(page.locator("#createMembershipOrder")).toBeEnabled();
  expect(control.calls.filter(path => path === "/api/payments/orders").length).toBeGreaterThan(0);
});

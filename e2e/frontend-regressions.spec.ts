import { expect, test, type Page, type Route } from "@playwright/test";

const user = {
  id: "frontend-user", username: "frontend.admin", displayName: "前端回归管理员", role: "admin",
  status: "active", mustChangePassword: false, createdAt: "2026-09-10T00:00:00.000Z"
};
const capabilities = { emailAuthEnabled: true, selfRegistrationEnabled: true };
const category = { id: "words", name: "测试单词", kind: "word", sortOrder: 0, status: "published" };
const items = ["apple", "banana", "cherry"].map((english, index) => ({
  id: `item-${index}`, key: english, english, meaning: `释义 ${index}`, pronunciation: "",
  categoryId: category.id, kind: "word", revision: 1, sortOrder: index, status: "published"
}));
const challengeId = "11111111-1111-4111-8111-111111111111";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function json(route: Route, body: unknown, status = 200): Promise<void> {
  await route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
}

async function mockApp(page: Page, options: { anonymous?: boolean; mistakes?: boolean } = {}) {
  let currentUser: typeof user | null = options.anonymous ? null : user;
  let sessions = 0;
  const requests: Array<{ path: string; body: Record<string, unknown> }> = [];
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const body = request.postDataJSON() as Record<string, unknown> | null;
    if (body) requests.push({ path, body });
    if (path === "/api/auth/session") return json(route, { user: currentUser, csrfToken: "test-csrf", capabilities });
    if (path === "/api/auth/logout") {
      currentUser = null;
      return route.fulfill({ status: 204 });
    }
    if (path === "/api/content") return json(route, { categories: [category], items, version: 1 });
    if (path === "/api/me/mistakes") return json(route, { items: options.mistakes ? [{ item: items[0], wrongCount: 1 }] : [] });
    if (path === "/api/me/summary") return json(route, { totals: { sessions: 0, attempts: 0, correct: 0, accuracy: 0 } });
    if (path === "/api/practice/sessions") return json(route, { session: { id: `session-${++sessions}`, startedAt: new Date().toISOString() } });
    if (path.endsWith("/attempts")) return json(route, { correct: body?.answer === items.find((item) => item.id === body.itemId)?.english, summary: {} });
    if (path.endsWith("/finish")) return json(route, { ok: true });
    if (path === "/api/auth/email/request-code") return json(route, { ok: true, challengeId, retryAfterSeconds: 1 });
    if (path === "/api/auth/email/bind") return json(route, { user: { ...user, email: body?.email, emailVerified: true }, csrfToken: "bound-csrf", capabilities });
    if (path === "/api/admin/users") return json(route, { users: [user] });
    if (path === "/api/admin/categories") return json(route, { categories: [category] });
    if (path === "/api/admin/items") return json(route, { items });
    if (path === "/api/admin/stats") return json(route, { stats: {} });
    if (path === "/api/admin/audit") return json(route, { entries: [] });
    throw new Error(`Unexpected mocked request: ${request.method()} ${path}`);
  });
  return { requests, sessionCount: () => sessions, setUser: (value: typeof user) => { currentUser = value; } };
}

async function readyPractice(page: Page): Promise<void> {
  await page.goto("/practice");
  await expect(page.locator("#answerInput")).toBeEnabled();
}

test("correct answers restore settings and mistakes mode can be exited when empty", async ({ page }) => {
  await mockApp(page, { mistakes: true });
  await readyPractice(page);
  await page.locator("#answerInput").fill("apple");
  await expect(page.locator("#targetWord")).toHaveText("banana");
  for (const selector of ["#categorySelect", "#orderSelect", "#resetButton"]) {
    await expect(page.locator(selector)).toBeEnabled();
  }
  await page.locator("#orderSelect").selectOption("mistakes");
  await expect(page.locator("#answerInput")).toBeEnabled();
  await page.locator("#answerInput").fill("apple");
  await expect(page.locator("#targetWord")).toHaveText("错题已练完");
  await expect(page.locator("#answerInput")).toBeDisabled();
  await expect(page.locator("#orderSelect")).toBeEnabled();
  await page.locator("#orderSelect").selectOption("shuffle");
  await expect(page.locator("#answerInput")).toBeEnabled();
});

test("a same-page navigation preserves an unsynchronized attempt and its idempotency key", async ({ page }) => {
  const mocked = await mockApp(page);
  const payloads: unknown[] = [];
  await page.route("**/api/practice/sessions/*/attempts", async (route) => {
    payloads.push(route.request().postDataJSON());
    if (payloads.length === 1) return route.abort("failed");
    await json(route, { correct: false, summary: {} });
  });
  await readyPractice(page);
  await page.locator("#answerInput").fill("incorrect");
  await page.locator("#answerInput").press("Enter");
  await expect(page.locator("#syncStrip")).toBeVisible();
  await page.getByRole("link", { name: "练习", exact: true }).click();
  await expect(page.locator("#syncStrip")).toBeVisible();
  await expect(page.locator("#answerInput")).toHaveValue("incorrect");
  expect(mocked.sessionCount()).toBe(1);
  await page.locator("#retrySyncButton").click();
  await expect(page.locator("#feedback")).toContainText("应输入");
  expect(payloads).toHaveLength(2);
  expect(payloads[1]).toEqual(payloads[0]);
  await expect(page.locator("#doneStat")).toHaveText("1");
});

test("an old attempt response cannot update a newly opened practice page", async ({ page }) => {
  await mockApp(page);
  const pending = deferred();
  let requested = false;
  await page.route("**/api/practice/sessions/*/attempts", async (route) => {
    requested = true;
    await pending.promise;
    await json(route, { correct: true, summary: { totalAttempts: 99 } });
  });
  await readyPractice(page);
  await page.locator("#answerInput").fill("apple");
  await expect.poll(() => requested).toBeTruthy();
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("link", { name: "管理后台", exact: true }).click();
  await page.getByRole("link", { name: "练习", exact: true }).click();
  await expect(page.locator("#answerInput")).toBeEnabled();
  pending.resolve();
  await page.waitForTimeout(500);
  await expect(page.locator("#targetWord")).toHaveText("apple");
  await expect(page.locator("#doneStat")).toHaveText("0");
  await expect(page.locator("#feedback")).toBeEmpty();
});

test("an old session-start response cannot replace the current session", async ({ page }) => {
  await mockApp(page);
  const pending = deferred();
  let starts = 0;
  let attemptPath = "";
  await page.route("**/api/practice/sessions", async (route) => {
    const id = ++starts;
    if (id === 1) await pending.promise;
    await json(route, { session: { id: `generation-${id}`, startedAt: new Date().toISOString() } });
  });
  await page.route("**/api/practice/sessions/*/attempts", async (route) => {
    attemptPath = new URL(route.request().url()).pathname;
    await json(route, { correct: false, summary: {} });
  });
  await page.goto("/practice");
  await expect.poll(() => starts).toBe(1);
  await page.getByRole("link", { name: "管理后台", exact: true }).click();
  await page.getByRole("link", { name: "练习", exact: true }).click();
  await expect(page.locator("#answerInput")).toBeEnabled();
  pending.resolve();
  await page.waitForTimeout(150);
  await page.locator("#answerInput").fill("wrong");
  await page.locator("#answerInput").press("Enter");
  await expect.poll(() => attemptPath).toBe("/api/practice/sessions/generation-2/attempts");
  await expect(page.locator("#lifetimeSessions")).toHaveText("1");
});

test("a delayed advance from a disposed practice page cannot skip a new page's first item", async ({ page }) => {
  await mockApp(page);
  const time = new Date("2026-09-10T00:00:00.000Z");
  await page.clock.install({ time });
  await page.clock.pauseAt(new Date(time.getTime() + 60_000));
  await readyPractice(page);
  await page.locator("#answerInput").fill("apple");
  await expect(page.locator("#feedback")).toHaveText("正确，已同步");
  await page.getByRole("link", { name: "管理后台", exact: true }).click();
  await page.getByRole("link", { name: "练习", exact: true }).click();
  await expect(page.locator("#answerInput")).toBeEnabled();
  await page.clock.runFor(500);
  await expect(page.locator("#targetWord")).toHaveText("apple");
  await expect(page.locator("#positionText")).toHaveText("1 / 3");
});

test("online recovery does not create another active practice session", async ({ page }) => {
  const mocked = await mockApp(page);
  await readyPractice(page);
  await page.evaluate(() => window.dispatchEvent(new Event("offline")));
  await expect(page.locator("#syncStrip")).toBeVisible();
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await expect(page.locator("#syncStrip")).toBeHidden();
  expect(mocked.sessionCount()).toBe(1);
});

test("repeated wrong answers count separate durations and long idle periods remain submittable", async ({ page }) => {
  const mocked = await mockApp(page);
  const startedAt = Date.parse("2026-09-10T00:00:00.000Z");
  await page.clock.setFixedTime(startedAt);
  await readyPractice(page);
  for (const elapsed of [5_000, 8_000, 7_208_000]) {
    await page.clock.setFixedTime(startedAt + elapsed);
    await page.locator("#answerInput").fill(`wrong-${elapsed}`);
    await page.locator("#answerInput").press("Enter");
    await expect(page.locator("#answerInput")).toBeEnabled();
  }
  const attempts = mocked.requests.filter((request) => request.path.endsWith("/attempts"));
  expect(attempts.map((request) => request.body.durationMs)).toEqual([5_000, 3_000, 3_600_000]);
});

test("changing email during an outstanding code request does not accept its challenge", async ({ page }) => {
  await mockApp(page, { anonymous: true });
  const pending = deferred();
  let requested = false;
  await page.route("**/api/auth/email/request-code", async (route) => {
    requested = true;
    await pending.promise;
    await json(route, { ok: true, challengeId, retryAfterSeconds: 1 });
  });
  await page.goto("/login");
  await page.locator("#emailLoginEmail").fill("first@example.com");
  await page.locator("#emailLoginSendCode").click();
  await expect.poll(() => requested).toBeTruthy();
  await page.locator("#emailLoginEmail").fill("second@example.com");
  pending.resolve();
  await expect(page.locator("#emailLoginSendCode")).toHaveAttribute("data-cooldown", "true");
  await expect(page.locator("#emailLoginChallengeId")).toHaveValue("");
  await expect(page.locator("#emailLoginSendStatus")).toBeHidden();
});

test("binding email immediately reveals the bound-email password form without resetting practice", async ({ page }) => {
  const mocked = await mockApp(page);
  await readyPractice(page);
  await page.locator("#nextButton").click();
  await expect(page.locator("#targetWord")).toHaveText("banana");
  await page.getByText("账号安全与邮箱", { exact: true }).click();
  const form = page.locator("#bindEmailForm");
  await form.locator('[name="email"]').fill("bound@example.com");
  await page.locator("#bindEmailSendCode").click();
  await expect(form.locator('[name="challengeId"]')).toHaveValue(challengeId);
  await form.locator('[name="code"]').fill("123456");
  await form.locator('[name="currentPassword"]').fill("current-password");
  await form.getByRole("button", { name: "确认绑定" }).click();
  await expect(page.locator("#emailPasswordForm")).toBeVisible();
  await expect(page.locator(".account-email")).toContainText("bound@example.com");
  await expect(page.locator("#bindEmailForm")).toHaveCount(0);
  await expect(page.locator("#targetWord")).toHaveText("banana");
  expect(mocked.sessionCount()).toBe(1);
});

test("a session identity change refreshes the displayed account before another write", async ({ page }) => {
  const mocked = await mockApp(page);
  await readyPractice(page);
  mocked.setUser({ ...user, id: "different-user", username: "different.admin", displayName: "另一个管理员" });
  await page.getByText("账号安全与邮箱", { exact: true }).click();
  await page.locator("#bindEmailInput").fill("binding@example.com");
  await page.locator("#bindEmailSendCode").click();
  await expect(page.locator(".user-chip strong")).toHaveText("另一个管理员");
  expect(mocked.requests.filter((request) => request.path === "/api/auth/email/request-code")).toHaveLength(0);
});

test("long prompts and names do not overflow a narrow mobile viewport", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 740 });
  const mocked = await mockApp(page);
  mocked.setUser({ ...user, displayName: "非常长的学员显示名称".repeat(8) });
  await page.route("**/api/content", (route) => json(route, {
    categories: [category], items: [{ ...items[0], english: "pneumonoultramicroscopicsilicovolcanoconiosis".repeat(3) }], version: 1
  }));
  await readyPractice(page);
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
});

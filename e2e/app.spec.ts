import { expect, test, type Page } from "@playwright/test";

const INITIAL_ADMIN_PASSWORD = "E2eInitialAdmin!2026";
const ADMIN_PASSWORD = "E2eChangedAdmin!2026";
const LEARNER_PASSWORD = "E2eChangedLearner!2026";
const OTHER_PASSWORD = "E2eChangedOther!2026";

let learnerTemporaryPassword = "";
let otherTemporaryPassword = "";

async function login(page: Page, username: string, password: string): Promise<void> {
  await page.goto("/login");
  await page.locator('[name="username"]').fill(username);
  await page.locator('[name="password"]').fill(password);
  await page.getByRole("button", { name: "登录", exact: true }).click();
}

async function changeForcedPassword(page: Page, currentPassword: string, nextPassword: string): Promise<void> {
  await expect(page.getByRole("heading", { name: "首次登录，请修改密码" })).toBeVisible();
  await page.locator('[name="currentPassword"]').fill(currentPassword);
  await page.locator('[name="newPassword"]').fill(nextPassword);
  await page.locator('[name="confirmPassword"]').fill(nextPassword);
  await page.getByRole("button", { name: "保存新密码" }).click();
}

test.describe.serial("multi-user application", () => {
  test("admin must change the bootstrap password and can issue accounts", async ({ page }) => {
    await login(page, "admin", INITIAL_ADMIN_PASSWORD);
    await changeForcedPassword(page, INITIAL_ADMIN_PASSWORD, ADMIN_PASSWORD);
    await expect(page).toHaveURL(/\/admin$/);
    await expect(page.getByRole("heading", { name: "管理后台" })).toBeVisible();

    await page.getByRole("button", { name: "用户管理" }).click();
    const form = page.locator("#createUserForm");
    await form.locator('[name="username"]').fill("learner1");
    await form.locator('[name="displayName"]').fill("测试学员一");
    await form.getByRole("button", { name: "创建并生成临时密码" }).click();
    learnerTemporaryPassword = (await page.locator("#temporaryPasswordValue").innerText()).trim();
    expect(learnerTemporaryPassword.length).toBeGreaterThanOrEqual(12);

    await form.locator('[name="username"]').fill("learner2");
    await form.locator('[name="displayName"]').fill("测试学员二");
    await form.getByRole("button", { name: "创建并生成临时密码" }).click();
    await expect(page.locator("#temporaryPasswordBox strong")).toContainText("learner2");
    await expect(page.locator("#temporaryPasswordValue")).not.toHaveText(learnerTemporaryPassword);
    otherTemporaryPassword = (await page.locator("#temporaryPasswordValue").innerText()).trim();
    expect(otherTemporaryPassword.length).toBeGreaterThanOrEqual(12);
    await expect(page.getByText("learner1", { exact: true })).toBeVisible();
    await expect(page.getByText("learner2", { exact: true })).toBeVisible();
  });

  test("learner imports legacy mistakes once and synchronizes answers", async ({ page }) => {
    await page.goto("/login");
    await page.evaluate(() => localStorage.setItem("basicTypingMistakes", JSON.stringify(["come", "come"])));
    await login(page, "learner1", learnerTemporaryPassword);
    await changeForcedPassword(page, learnerTemporaryPassword, LEARNER_PASSWORD);
    await expect(page).toHaveURL(/\/practice$/);
    await expect(page.getByText(/已载入 850 个单词，168 条句型/)).toBeVisible();
    await expect(page.locator("#categorySelect option")).toHaveCount(19);

    await expect(page.locator("#legacyBanner")).toBeVisible();
    await page.getByRole("button", { name: "确认导入" }).click();
    await expect(page.locator("#legacyBanner")).toBeHidden();
    await expect.poll(() => page.evaluate(() => localStorage.getItem("basicTypingMistakes"))).toBeNull();

    const firstTarget = (await page.locator("#targetWord").innerText()).trim();
    expect(firstTarget.length).toBeGreaterThan(0);
    await page.locator("#answerInput").fill("definitely-wrong");
    await page.locator("#answerInput").press("Enter");
    await expect(page.locator("#feedback")).toContainText("应输入：");
    await page.locator("#answerInput").fill(firstTarget);
    await page.locator("#answerInput").press("Enter");
    await expect(page.locator("#feedback")).toHaveText("正确，已同步");
    await expect.poll(async () => Number(await page.locator("#doneStat").innerText())).toBeGreaterThanOrEqual(2);
    await expect(page.locator("#speakButton")).toBeEnabled();
    await page.locator("#speakButton").click();
  });

  test("a second user cannot see another user's mistakes or admin data", async ({ page }) => {
    await login(page, "learner2", otherTemporaryPassword);
    await changeForcedPassword(page, otherTemporaryPassword, OTHER_PASSWORD);
    await expect(page).toHaveURL(/\/practice$/);
    await expect(page.locator("#mistakeStat")).toHaveText("0");
    const adminStatus = await page.evaluate(async () => (await fetch("/api/admin/stats", { credentials: "include" })).status);
    expect(adminStatus).toBe(403);
    await page.goto("/admin");
    await expect(page).toHaveURL(/\/practice$/);
  });

  test("a slow practice request cannot overwrite a page the user has left", async ({ page }) => {
    await login(page, "admin", ADMIN_PASSWORD);
    await expect(page).toHaveURL(/\/admin$/);
    await page.route("**/api/content", async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 700));
      await route.continue();
    });
    await page.getByRole("link", { name: "练习", exact: true }).click();
    await page.getByRole("link", { name: "管理后台", exact: true }).click();
    await page.waitForTimeout(1_000);
    await expect(page).toHaveURL(/\/admin$/);
    await expect(page.getByRole("heading", { name: "管理后台" })).toBeVisible();
  });

  test("an unsynchronized answer warns before leaving and remains retryable", async ({ page }) => {
    await login(page, "learner1", LEARNER_PASSWORD);
    await expect(page).toHaveURL(/\/practice$/);
    await page.route("**/api/practice/sessions/*/attempts", (route) => route.abort("failed"));
    await page.locator("#answerInput").fill("network-failure-answer");
    await page.locator("#answerInput").press("Enter");
    await expect(page.locator("#syncStrip")).toBeVisible();
    page.once("dialog", (dialog) => dialog.dismiss());
    await page.getByRole("button", { name: "退出" }).click();
    await expect(page).toHaveURL(/\/practice$/);
    await page.unroute("**/api/practice/sessions/*/attempts");
    await page.getByRole("button", { name: "重试同步" }).click();
    await expect(page.locator("#feedback")).toContainText("应输入：");
    await expect(page.locator("#syncStrip")).toBeHidden();
  });

  test("a revoked or missing session during a write returns the user to login", async ({ page, context }) => {
    await login(page, "learner1", LEARNER_PASSWORD);
    await expect(page).toHaveURL(/\/practice$/);
    await context.clearCookies();
    await page.locator("#answerInput").fill("session-was-revoked");
    await page.locator("#answerInput").press("Enter");
    await expect(page).toHaveURL(/\/login$/);
    await expect(page.getByRole("heading", { name: "英语打字练习" })).toBeVisible();
  });

  test("logout also recovers when the session was already revoked", async ({ page, context }) => {
    await login(page, "learner1", LEARNER_PASSWORD);
    await expect(page).toHaveURL(/\/practice$/);
    await context.clearCookies();
    await page.getByRole("button", { name: "退出" }).click();
    await expect(page).toHaveURL(/\/login$/);
    await expect(page.getByRole("heading", { name: "英语打字练习" })).toBeVisible();
  });

  test("logout revokes the user session", async ({ page }) => {
    await login(page, "learner1", LEARNER_PASSWORD);
    await expect(page).toHaveURL(/\/practice$/);
    await page.getByRole("button", { name: "退出" }).click();
    await expect(page).toHaveURL(/\/login$/);
    const session = await page.evaluate(async () => (await fetch("/api/auth/session", { credentials: "include" })).json());
    expect(session.user).toBeNull();
    expect(session.csrfToken).toBeTruthy();
  });

  test("PWA assets are installable and API responses are excluded from caching", async ({ request }) => {
    const manifest = await request.get("/manifest.webmanifest");
    expect(manifest.ok()).toBeTruthy();
    const body = await manifest.json();
    expect(body.start_url).toBe("/practice");
    expect(body.icons).toHaveLength(2);
    const worker = await (await request.get("/sw.js")).text();
    expect(worker).toContain('url.pathname.startsWith("/api/")');
    expect(worker).not.toContain('caches.addAll(["/api');
  });
});

test("mobile layout stacks the practice sidebar", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page, "learner1", LEARNER_PASSWORD);
  await expect(page).toHaveURL(/\/practice$/);
  const layout = await page.evaluate(() => {
    const main = document.querySelector<HTMLElement>(".practice-main")!.getBoundingClientRect();
    const side = document.querySelector<HTMLElement>(".practice-side")!.getBoundingClientRect();
    return { mainWidth: main.width, sideWidth: side.width, sideTop: side.top, mainBottom: main.bottom };
  });
  expect(layout.mainWidth).toBeLessThanOrEqual(390);
  expect(layout.sideWidth).toBeLessThanOrEqual(390);
  expect(layout.sideTop).toBeGreaterThanOrEqual(layout.mainBottom - 1);
});

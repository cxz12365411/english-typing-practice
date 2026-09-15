import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";

const INITIAL_ADMIN_PASSWORD = "E2eInitialAdmin!2026";
const ADMIN_PASSWORD = "E2eChangedAdmin!2026";
const LEARNER_PASSWORD = "E2eChangedLearner!2026";
const OTHER_PASSWORD = "E2eChangedOther!2026";
const EMAIL_RESET_PASSWORD = "E2eEmailResetChanged!2026";
const EMAIL_REGISTER_PASSWORD = "E2eEmailRegistered!2026";
const EMAIL_OUTBOX_FILE = join(tmpdir(), "english-typing-practice-e2e-mail-outbox-8091.jsonl");

let learnerTemporaryPassword = "";
let otherTemporaryPassword = "";

async function login(page: Page, username: string, password: string): Promise<void> {
  await page.goto("/login");
  const passwordTab = page.getByRole("tab", { name: "账号密码" });
  if (await passwordTab.count()) await passwordTab.click();
  const form = page.locator("#passwordLoginForm");
  await form.locator('[name="username"]').fill(username);
  await form.locator('[name="password"]').fill(password);
  await form.getByRole("button", { name: "登录", exact: true }).click();
}

interface CapturedEmail {
  to: string;
  code: string;
  purpose: "register" | "login" | "reset_password" | "bind_email";
}

function capturedCode(email: string, purpose: CapturedEmail["purpose"]): string | null {
  if (!existsSync(EMAIL_OUTBOX_FILE)) return null;
  const messages = readFileSync(EMAIL_OUTBOX_FILE, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as CapturedEmail)
    .filter((message) => message.to === email && message.purpose === purpose);
  return messages.at(-1)?.code ?? null;
}

async function waitForCapturedCode(email: string, purpose: CapturedEmail["purpose"]): Promise<string> {
  await expect.poll(() => capturedCode(email, purpose), { timeout: 5_000 }).toMatch(/^\d{6}$/);
  return capturedCode(email, purpose)!;
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
    await expect(page.getByText(/已载入 850 个单词，182 条句型/)).toBeVisible();
    await expect(page.locator("#categorySelect option")).toHaveCount(23);

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

  test("street photography categories preserve phrases and synchronize a typographic apostrophe answer", async ({ page }) => {
    await login(page, "learner1", LEARNER_PASSWORD);
    await expect(page).toHaveURL(/\/practice$/);

    const groups = [
      {
        label: "句型：街头摄影：开场与征求同意",
        count: 4,
        english: "Hi, excuse me. I'm a street photographer.",
        meaning: "你好，打扰一下。我是一名街头摄影师。",
        pronunciation: "嗨，伊克斯丘兹 米。艾姆 额 斯垂特 佛塔格若弗。"
      },
      {
        label: "句型：街头摄影：拍摄时引导动作",
        count: 5,
        english: "Could you stand here, please?",
        meaning: "可以请你站在这里吗？",
        pronunciation: "库德 优 斯坦德 希尔，普利兹？"
      },
      {
        label: "句型：街头摄影：看图和发送照片",
        count: 3,
        english: "Would you like to see the photos?",
        meaning: "你想看看照片吗？",
        pronunciation: "伍德 优 赖克 特 西 德 佛头兹？"
      },
      {
        label: "句型：街头摄影：礼貌结束",
        count: 2,
        english: "Thanks for your time. Have a great day!",
        meaning: "谢谢你抽出时间，祝你今天愉快！",
        pronunciation: "桑克斯 佛 尤尔 泰姆。海夫 额 格瑞特 得诶！"
      }
    ];
    for (const group of groups) {
      await page.locator("#categorySelect").selectOption({ label: group.label });
      await expect(page.locator("#answerInput")).toBeEnabled();
      await expect(page.locator("#targetWord")).toHaveText(group.english);
      await expect(page.locator("#meaningText")).toHaveText(group.meaning);
      await expect(page.locator("#pronunciationText")).toHaveText(`中文谐音：${group.pronunciation}`);
      await expect(page.locator("#positionText")).toHaveText(`1 / ${group.count}`);
    }

    await page.locator("#categorySelect").selectOption({ label: groups[0].label });
    await expect(page.locator("#targetWord")).toHaveText(groups[0].english);
    await expect(page.locator("#answerInput")).toBeEnabled();
    const before = await (await page.request.get("/api/me/summary")).json();
    const submitted = page.waitForResponse((response) => (
      /\/api\/practice\/sessions\/[^/]+\/attempts$/.test(new URL(response.url()).pathname)
      && response.request().method() === "POST"
    ));
    await page.locator("#answerInput").fill("Hi, excuse me. I’m a street photographer.");
    const response = await submitted;
    expect(response.ok()).toBeTruthy();
    const result = await response.json();
    expect(result.attempt.correct).toBe(true);
    expect(result.attempt.itemId).toBe(response.request().postDataJSON().itemId);
    expect(result.summary.done).toBe(1);
    await expect(page.locator("#targetWord")).toHaveText("I really like your style.");

    await page.reload();
    await expect(page.locator("#answerInput")).toBeEnabled();
    const after = await (await page.request.get("/api/me/summary")).json();
    expect(after.totals.attempts).toBe(before.totals.attempts + 1);
    expect(after.totals.correct).toBe(before.totals.correct + 1);
    await expect(page.locator("#lifetimeAttempts")).toHaveText(String(after.totals.attempts));
  });

  test("an existing user can bind a verified email", async ({ page }) => {
    const email = "learner2@example.com";
    await login(page, "learner2", OTHER_PASSWORD);
    await expect(page).toHaveURL(/\/practice$/);
    await page.getByText("账号安全与邮箱", { exact: true }).click();
    const form = page.locator("#bindEmailForm");
    await form.locator('[name="email"]').fill(email);
    await form.getByRole("button", { name: "发送验证码" }).click();
    const code = await waitForCapturedCode(email, "bind_email");
    await form.locator('[name="code"]').fill(code);
    await form.locator('[name="currentPassword"]').fill(OTHER_PASSWORD);
    await form.getByRole("button", { name: "确认绑定" }).click();
    await expect(page.locator(".account-email")).toContainText(email);
    await expect(page.locator("#emailPasswordForm")).toBeVisible();
  });

  test("email verification code logs a verified user in", async ({ page }) => {
    const email = "email.login@example.com";
    await page.goto("/login");
    await expect(page.getByRole("tab", { name: "验证码登录" })).toHaveAttribute("aria-selected", "true");
    const form = page.locator("#emailLoginForm");
    await form.locator('[name="email"]').fill(email);
    await form.getByRole("button", { name: "发送验证码" }).click();
    const code = await waitForCapturedCode(email, "login");
    await form.locator('[name="code"]').fill(code);
    await form.getByRole("button", { name: "登录", exact: true }).click();
    await expect(page).toHaveURL(/\/practice$/);
    await expect(page.getByText(/已载入 850 个单词，182 条句型/)).toBeVisible();
  });

  test("email verification code resets a password and revokes the old password", async ({ page }) => {
    const email = "email.reset@example.com";
    await page.goto("/login");
    await page.getByRole("tab", { name: "找回密码" }).click();
    const form = page.locator("#resetPasswordForm");
    await form.locator('[name="email"]').fill(email);
    await form.getByRole("button", { name: "发送验证码" }).click();
    const code = await waitForCapturedCode(email, "reset_password");
    await form.locator('[name="code"]').fill(code);
    await form.locator('[name="newPassword"]').fill(EMAIL_RESET_PASSWORD);
    await form.locator('[name="confirmPassword"]').fill(EMAIL_RESET_PASSWORD);
    await form.getByRole("button", { name: "验证并修改密码" }).click();
    await expect(page).toHaveURL(/\/practice$/);

    await page.getByRole("button", { name: "退出" }).click();
    await login(page, "email.reset", "E2eEmailReset!2026");
    await expect(page).toHaveURL(/\/login$/);
    await expect(page.locator("#passwordLoginMessage")).toContainText("账号或密码错误");
    await login(page, "email.reset", EMAIL_RESET_PASSWORD);
    await expect(page).toHaveURL(/\/practice$/);
  });

  test("a visitor can create only a learner account after verifying email", async ({ page }) => {
    const email = "email.register@example.com";
    await page.goto("/login");
    await page.getByRole("tab", { name: "注册账号" }).click();
    const form = page.locator("#registerForm");
    await form.locator('[name="email"]').fill(email);
    await form.getByRole("button", { name: "发送验证码" }).click();
    const code = await waitForCapturedCode(email, "register");
    await form.locator('[name="code"]').fill(code);
    await form.locator('[name="username"]').fill("email.register");
    await form.locator('[name="displayName"]').fill("邮箱注册学员");
    await form.locator('[name="password"]').fill(EMAIL_REGISTER_PASSWORD);
    await form.locator('[name="confirmPassword"]').fill(EMAIL_REGISTER_PASSWORD);
    await form.getByRole("button", { name: "注册并登录" }).click();
    await expect(page).toHaveURL(/\/practice$/);
    const adminStatus = await page.evaluate(async () => (await fetch("/api/admin/stats", { credentials: "include" })).status);
    expect(adminStatus).toBe(403);
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

test("mobile layout stacks the practice sidebar and wraps a street photography phrase", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page, "learner1", LEARNER_PASSWORD);
  await expect(page).toHaveURL(/\/practice$/);
  await page.locator("#categorySelect").selectOption({ label: "句型：街头摄影：开场与征求同意" });
  await expect(page.locator("#targetWord")).toHaveText("Hi, excuse me. I'm a street photographer.");
  await expect(page.locator("#answerInput")).toBeEnabled();
  const layout = await page.evaluate(() => {
    const main = document.querySelector<HTMLElement>(".practice-main")!.getBoundingClientRect();
    const side = document.querySelector<HTMLElement>(".practice-side")!.getBoundingClientRect();
    const target = document.querySelector<HTMLElement>("#targetWord")!;
    const targetRect = target.getBoundingClientRect();
    return {
      mainWidth: main.width,
      sideWidth: side.width,
      sideTop: side.top,
      mainBottom: main.bottom,
      pageWidth: document.documentElement.scrollWidth,
      viewportWidth: window.innerWidth,
      targetLeft: targetRect.left,
      targetRight: targetRect.right,
      targetScrollWidth: target.scrollWidth,
      targetClientWidth: target.clientWidth
    };
  });
  expect(layout.mainWidth).toBeLessThanOrEqual(390);
  expect(layout.sideWidth).toBeLessThanOrEqual(390);
  expect(layout.sideTop).toBeGreaterThanOrEqual(layout.mainBottom - 1);
  expect(layout.pageWidth).toBeLessThanOrEqual(layout.viewportWidth);
  expect(layout.targetLeft).toBeGreaterThanOrEqual(0);
  expect(layout.targetRight).toBeLessThanOrEqual(layout.viewportWidth);
  expect(layout.targetScrollWidth).toBeLessThanOrEqual(layout.targetClientWidth);
});

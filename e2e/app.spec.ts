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
  const form = page.locator("#passwordLoginForm");
  // Session capabilities load asynchronously before the available login modes render.
  await expect(form).toBeAttached();
  const passwordTab = page.getByRole("tab", { name: "账号密码" });
  if (await passwordTab.count()) await passwordTab.click();
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
    await expect(page.getByText(/已载入 850 个单词，270 条句型/)).toBeVisible();
    await expect(page.locator("#categorySelect option")).toHaveCount(27);

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

  test("bar social categories show eight complete phrases each without submitting learner answers", async ({ page }) => {
    await login(page, "learner1", LEARNER_PASSWORD);
    await expect(page).toHaveURL(/\/practice$/);
    const before = await (await page.request.get("/api/me/summary")).json();
    const content = await (await page.request.get("/api/content")).json();
    const groups = [
      { label: "句型：酒吧社交：开场与轻松夸赞", english: "Hey, is this seat taken?", meaning: "嗨，这个位子有人坐吗？" },
      { label: "句型：酒吧社交：点酒与碰杯", english: "What are you drinking?", meaning: "你喝的是什么？" },
      { label: "句型：酒吧社交：闲聊与邀请", english: "What brings you out tonight?", meaning: "你今晚怎么想到出来玩？" },
      { label: "句型：酒吧社交：交换联系方式与礼貌结束", english: "Would you like to exchange numbers?", meaning: "你愿意交换电话号码吗？" }
    ];
    for (const group of groups) {
      const item = content.items.find((entry: { english: string }) => entry.english === group.english);
      expect(item?.pronunciation).toBeTruthy();
      await page.locator("#categorySelect").selectOption({ label: group.label });
      await expect(page.locator("#answerInput")).toBeEnabled();
      await expect(page.locator("#targetWord")).toHaveText(group.english);
      await expect(page.locator("#meaningText")).toHaveText(group.meaning);
      await expect(page.locator("#pronunciationText")).toHaveText(`中文谐音：${item.pronunciation}`);
      await expect(page.locator("#positionText")).toHaveText("1 / 8");
      await expect(page.locator("#answerInput")).toHaveValue("");
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator("#categorySelect").selectOption({ label: groups[1]!.label });
    for (let position = 2; position <= 4; position += 1) {
      await page.locator("#nextButton").click();
      await expect(page.locator("#positionText")).toHaveText(`${position} / 8`);
    }
    await expect(page.locator("#targetWord")).toHaveText("Would you prefer something non-alcoholic?");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.reload();
    await expect(page.locator("#answerInput")).toBeEnabled();
    // Regular practice resets to all content on refresh; only import batches
    // promise persisted scope. Re-select the public category to verify availability.
    await page.locator("#categorySelect").selectOption({ label: groups[1]!.label });
    await expect(page.locator("#targetWord")).toHaveText(groups[1]!.english);
    await expect(page.locator("#positionText")).toHaveText("1 / 8");
    const after = await (await page.request.get("/api/me/summary")).json();
    expect(after.totals.attempts).toBe(before.totals.attempts);
    expect(after.totals.correct).toBe(before.totals.correct);
    expect(after.totals.mistakes).toBe(before.totals.mistakes);
  });

  test("street photography categories preserve old phrases, expose additions, and synchronize both answers", async ({ page }) => {
    await login(page, "learner1", LEARNER_PASSWORD);
    await expect(page).toHaveURL(/\/practice$/);

    const groups = [
      {
        label: "句型：街头摄影：开场与征求同意",
        count: 18,
        septemberCount: 10,
        originalCount: 4,
        english: "Hi, excuse me. I'm a street photographer.",
        meaning: "你好，打扰一下。我是一名街头摄影师。",
        pronunciation: "嗨，伊克斯丘兹 米。艾姆 额 斯垂特 佛塔格若弗。",
        addition: "I'm working on a street photography project.",
        additionMeaning: "我正在做一个街头摄影项目。",
        additionPronunciation: "艾姆 沃金 昂 额 斯垂特 佛塔格若菲 普拉杰克特。",
        octoberAddition: "Hi! Do you have a moment?",
        octoberMeaning: "你好！你现在有空吗？",
        octoberPronunciation: "嗨！杜 优 海夫 额 莫门特？"
      },
      {
        label: "句型：街头摄影：拍摄时引导动作",
        count: 19,
        septemberCount: 11,
        originalCount: 5,
        english: "Could you stand here, please?",
        meaning: "可以请你站在这里吗？",
        pronunciation: "库德 优 斯坦德 希尔，普利兹？",
        addition: "Relax your shoulders.",
        additionMeaning: "肩膀放松一点。",
        additionPronunciation: "瑞拉克斯 尤尔 舒尔德兹。",
        octoberAddition: "Please look at the camera.",
        octoberMeaning: "请看镜头。",
        octoberPronunciation: "普利兹 卢克 艾特 德 卡梅若。"
      },
      {
        label: "句型：街头摄影：看图和发送照片",
        count: 17,
        septemberCount: 9,
        originalCount: 3,
        english: "Would you like to see the photos?",
        meaning: "你想看看照片吗？",
        pronunciation: "伍德 优 赖克 特 西 德 佛头兹？",
        addition: "Which photo do you like best?",
        additionMeaning: "你最喜欢哪一张？",
        additionPronunciation: "威奇 佛头 杜 优 赖克 贝斯特？",
        octoberAddition: "Here are the photos.",
        octoberMeaning: "这些就是拍好的照片。",
        octoberPronunciation: "希尔 阿尔 德 佛头兹。"
      },
      {
        label: "句型：街头摄影：礼貌结束",
        count: 16,
        septemberCount: 8,
        originalCount: 2,
        english: "Thanks for your time. Have a great day!",
        meaning: "谢谢你抽出时间，祝你今天愉快！",
        pronunciation: "桑克斯 佛 尤尔 泰姆。海夫 额 格瑞特 得诶！",
        addition: "Thank you for being part of my project.",
        additionMeaning: "谢谢你参与我的项目。",
        additionPronunciation: "桑克 优 佛 比英 帕尔特 阿夫 买 普拉杰克特。",
        octoberAddition: "We're all done.",
        octoberMeaning: "我们拍好了。",
        octoberPronunciation: "威尔 奥尔 丹。"
      }
    ];
    for (const group of groups) {
      await page.locator("#categorySelect").selectOption({ label: group.label });
      await expect(page.locator("#answerInput")).toBeEnabled();
      await expect(page.locator("#targetWord")).toHaveText(group.english);
      await expect(page.locator("#meaningText")).toHaveText(group.meaning);
      await expect(page.locator("#pronunciationText")).toHaveText(`中文谐音：${group.pronunciation}`);
      await expect(page.locator("#positionText")).toHaveText(`1 / ${group.count}`);
      for (let position = 2; position <= group.originalCount + 1; position += 1) {
        await page.locator("#nextButton").click();
        await expect(page.locator("#positionText")).toHaveText(`${position} / ${group.count}`);
      }
      await expect(page.locator("#targetWord")).toHaveText(group.addition);
      await expect(page.locator("#meaningText")).toHaveText(group.additionMeaning);
      await expect(page.locator("#pronunciationText")).toHaveText(`中文谐音：${group.additionPronunciation}`);
      for (let position = group.originalCount + 2; position <= group.septemberCount + 1; position += 1) {
        await page.locator("#nextButton").click();
        await expect(page.locator("#positionText")).toHaveText(`${position} / ${group.count}`);
      }
      await expect(page.locator("#targetWord")).toHaveText(group.octoberAddition);
      await expect(page.locator("#meaningText")).toHaveText(group.octoberMeaning);
      await expect(page.locator("#pronunciationText")).toHaveText(`中文谐音：${group.octoberPronunciation}`);
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

    for (let position = 3; position <= 5; position += 1) {
      await page.locator("#nextButton").click();
      await expect(page.locator("#positionText")).toHaveText(`${position} / ${groups[0].count}`);
    }
    await expect(page.locator("#targetWord")).toHaveText(groups[0].addition);
    const additionSubmitted = page.waitForResponse((response) => (
      /\/api\/practice\/sessions\/[^/]+\/attempts$/.test(new URL(response.url()).pathname)
      && response.request().method() === "POST"
    ));
    await page.locator("#answerInput").fill(groups[0].addition);
    const additionResponse = await additionSubmitted;
    expect(additionResponse.ok()).toBeTruthy();
    const additionResult = await additionResponse.json();
    expect(additionResult.attempt.correct).toBe(true);
    expect(additionResult.attempt.itemId).toBe(additionResponse.request().postDataJSON().itemId);
    expect(additionResult.attempt.itemId).not.toBe(result.attempt.itemId);
    expect(additionResult.summary.done).toBe(2);
    await expect(page.locator("#targetWord")).toHaveText("Your outfit really caught my eye.");

    await page.reload();
    await expect(page.locator("#answerInput")).toBeEnabled();
    const after = await (await page.request.get("/api/me/summary")).json();
    expect(after.totals.attempts).toBe(before.totals.attempts + 2);
    expect(after.totals.correct).toBe(before.totals.correct + 2);
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
    await expect(page.getByText(/已载入 850 个单词，270 条句型/)).toBeVisible();
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

test("mobile layout stacks the sidebar, scrolls the alignment diagram and wraps plain text", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page, "learner1", LEARNER_PASSWORD);
  await expect(page).toHaveURL(/\/practice$/);
  await page.locator("#categorySelect").selectOption({ label: "句型：街头摄影：礼貌结束" });
  await expect(page.locator("#targetWord")).toHaveText("Thanks for your time. Have a great day!");
  await expect(page.locator("#answerInput")).toBeEnabled();
  for (let position = 2; position <= 8; position += 1) {
    await page.locator("#nextButton").click();
    await expect(page.locator("#positionText")).toHaveText(`${position} / 16`);
  }
  await expect(page.locator("#targetWord")).toHaveText("Feel free to message me if you have any questions.");
  await expect(page.locator("#meaningText")).toHaveText("有任何问题，随时给我发消息。");
  await expect(page.locator("#pronunciationText")).toHaveText("中文谐音：菲尔 弗瑞 特 梅瑟吉 米 伊夫 优 海夫 艾尼 奎斯辰兹。");
  await expect(page.locator(".alignment-path").first()).toBeAttached();
  const diagram = await page.locator("#alignmentScroll").evaluate((element) => ({
    width: element.clientWidth,
    scroll: element.scrollWidth,
    right: element.getBoundingClientRect().right,
    page: document.documentElement.scrollWidth,
    viewport: innerWidth
  }));
  expect(diagram.scroll).toBeGreaterThan(diagram.width);
  expect(diagram.right).toBeLessThanOrEqual(diagram.viewport);
  expect(diagram.page).toBeLessThanOrEqual(diagram.viewport);
  await page.locator("#showAlignment").uncheck();
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

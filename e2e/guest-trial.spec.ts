import { expect, test } from "@playwright/test";

test("guest can type with alignment, retains the deadline, and reaches email registration after expiry", async ({ page, context }) => {
  await page.clock.install({ time: new Date() });
  await page.route("**/api/auth/session", (route) => route.fulfill({ json: {
    user: null,
    csrfToken: "trial-test",
    capabilities: { emailAuthEnabled: true, selfRegistrationEnabled: true, membershipEnabled: true }
  } }));
  const practiceRequests: string[] = [];
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (path.startsWith("/api/") && path !== "/api/auth/session") practiceRequests.push(path);
  });

  await page.goto("/login");
  await expect(page.getByRole("img", { name: "客服微信二维码" })).toHaveCount(0);
  await expect(page.locator(".login-story").getByRole("link", { name: "立即试用" })).toHaveCount(0);
  await page.locator(".auth-card").getByRole("link", { name: "立即试用" }).click();
  await expect(page).toHaveURL(/\/trial$/);
  await expect(page.getByRole("timer")).toHaveText(/^(10:00|09:5[5-9])$/);

  const input = page.getByRole("textbox", { name: "照着上面的英文输入，按回车检查" });
  const english = page.locator("#trialEnglish");
  await expect(english).toHaveText("Hi, how are you?");
  await input.fill("Hi");
  await expect(page.locator("#trialAlignmentStage")).toHaveClass(/has-highlight/);
  await input.press("Enter");
  await expect(page.locator("#guestTrialFeedback")).toContainText("再对照一下");
  await input.fill("Hi, how are you?");
  await input.press("Enter");
  await expect(page.locator("#guestTrialFeedback")).toContainText("答对了");
  await expect(english).toHaveText("Hey, is this seat taken?");
  expect(practiceRequests).toEqual([]);

  await page.clock.fastForward(9 * 60_000 + 10_000);
  await page.reload();
  await expect(page.getByRole("timer")).toHaveText(/^00:[0-4][0-9]$/);
  await page.clock.fastForward(51_000);
  await expect(page.getByRole("heading", { name: "10 分钟试用已结束" })).toBeVisible();
  await expect(input).toBeHidden();
  await expect(page.getByText(/24 小时完整练习/)).toBeVisible();

  const anotherTab = await context.newPage();
  await anotherTab.clock.install({ time: new Date(Date.now() + 610_000) });
  await anotherTab.goto("/trial");
  await expect(anotherTab.getByRole("heading", { name: "10 分钟试用已结束" })).toBeVisible();
  await anotherTab.close();

  await page.getByRole("link", { name: "免费注册" }).click();
  await expect(page).toHaveURL(/\/login\?mode=register$/);
  await expect(page.getByRole("tab", { name: "注册账号" })).toHaveAttribute("aria-selected", "true");
  await page.goBack();
  await expect(page.getByRole("heading", { name: "10 分钟试用已结束" })).toBeVisible();
});

test("long writing prompts stay inside the guest demo on mobile", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 800 });
  await page.goto("/login");
  await page.getByRole("link", { name: "立即试用" }).click();
  for (let index = 0; index < 8; index += 1) await page.getByRole("button", { name: "下一题" }).click();
  await expect(page.locator("#guestTrialCategory")).toHaveText("四级写作");
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(375);
  const hasInternalScroll = await page.locator("#trialAlignmentScroll").evaluate((element) => element.scrollWidth > element.clientWidth);
  expect(hasInternalScroll).toBe(true);
});

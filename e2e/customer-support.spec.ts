import { expect, test } from "@playwright/test";

test("signed-in learners can scan the support QR and return to their current exercise", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 800 });
  await page.goto("/login");
  await page.getByRole("tab", { name: "账号密码" }).click();
  const login = page.locator("#passwordLoginForm");
  await login.getByLabel("账号").fill("email.login");
  await login.getByLabel("密码").fill("E2eEmailLogin!2026");
  await login.getByRole("button", { name: "登录", exact: true }).click();

  await expect(page).toHaveURL(/\/practice$/);
  const answer = page.locator("#answerInput");
  await answer.fill("typing in progress");

  const support = page.getByRole("button", { name: "联系客服" });
  const dialog = page.getByRole("dialog", { name: "客服微信" });
  await support.click();
  await expect(dialog).toBeVisible();
  const qrCode = dialog.getByRole("img", { name: "客服微信二维码" });
  await expect.poll(() => qrCode.evaluate((image: HTMLImageElement) => image.naturalWidth)).toBe(648);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(375);
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(support).toBeFocused();
  await expect(answer).toHaveValue("typing in progress");

  await page.getByRole("link", { name: "会员与记录" }).click();
  await expect(page).toHaveURL(/\/membership$/);
  await support.click();
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "关闭" }).click();
  await expect(dialog).toBeHidden();
  await page.getByRole("button", { name: "退出" }).click();
  await expect(page.locator(".auth-card").getByRole("link", { name: "立即试用" })).toBeVisible();
  await expect(page.getByRole("button", { name: "联系客服" })).toHaveCount(0);
});

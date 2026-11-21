import { expect, test } from "@playwright/test";

test("a signed-in learner can choose and answer the new travel shopping category", async ({ page }) => {
  await page.goto("/login");
  await page.getByRole("tab", { name: "账号密码" }).click();
  const form = page.locator("#passwordLoginForm");
  await form.locator('[name="username"]').fill("md.other");
  await form.locator('[name="password"]').fill("E2eMarkdownOwner!2026");
  await form.getByRole("button", { name: "登录", exact: true }).click();
  await expect(page).toHaveURL(/\/practice$/);

  const category = "句型：旅游购物与砍价";
  const first = "How much is this one?";
  await page.locator("#categorySelect").selectOption({ label: category });
  await expect(page.locator("#categoryText")).toHaveText(category);
  await expect(page.locator("#positionText")).toHaveText("1 / 24");
  await expect(page.locator("#targetWord")).toHaveText(first);
  await expect(page.locator("#meaningText")).toHaveText("这个多少钱？");
  await expect(page.locator(".alignment-path").first()).toBeVisible();
  await expect(page.locator("#pronunciationText")).toContainText("豪 马奇");

  const savedAttempt = page.waitForResponse((response) =>
    response.request().method() === "POST" && /\/api\/practice\/sessions\/[^/]+\/attempts$/.test(new URL(response.url()).pathname)
  );
  await page.locator("#answerInput").fill(first);
  const response = await savedAttempt;
  expect(response.ok()).toBeTruthy();
  expect((await response.json()).attempt.correct).toBe(true);
  await expect(page.locator("#positionText")).toHaveText("2 / 24");
  await expect(page.locator("#targetWord")).toHaveText("How much are these?");
});

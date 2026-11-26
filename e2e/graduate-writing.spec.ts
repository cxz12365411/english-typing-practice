import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";

const data = JSON.parse(readFileSync("graduate-writing.json", "utf8"));
const parsed = require("../cet4-writing.js").parse(data);

async function signIn(page: Page) {
  await page.goto("/login");
  await page.getByRole("tab", { name: "账号密码" }).click();
  const form = page.locator("#passwordLoginForm");
  await form.locator('[name="username"]').fill("md.other");
  await form.locator('[name="password"]').fill("E2eMarkdownOwner!2026");
  await form.getByRole("button", { name: "登录", exact: true }).click();
  await expect(page).toHaveURL(/\/practice$/);
  await expect(page.locator("#answerInput")).toBeEnabled();
}

test("graduate writing includes both tracks and preserves picture and chart material with the answer hidden", async ({ page }) => {
  await signIn(page);
  const categories = page.locator("#categorySelect");
  await expect(categories.locator("option").filter({ hasText: /^考研英语/ })).toHaveText(
    parsed.categories.map((category: { name: string }) => category.name)
  );
  const materials = page.locator(".graduate-materials");
  const preview = page.locator(".cet4-preview");
  const shortEssay = data.essays[0];
  await categories.selectOption({ label: parsed.categories[0].name });
  await expect(page.locator("#positionText")).toHaveText("1 / 6");
  await materials.locator("summary").click();
  await expect(materials.locator(".cet4-prompt")).toHaveText(shortEssay.prompt);
  await preview.locator("summary").click();
  const first = shortEssay.paragraphs[0][0];
  await expect(preview.locator(".cet4-english .is-current")).toHaveText(first.english);
  const attemptSaved = page.waitForResponse(response =>
    response.request().method() === "POST" && /\/api\/practice\/sessions\/[^/]+\/attempts$/.test(new URL(response.url()).pathname)
  );
  await page.locator("#answerInput").fill(first.english);
  expect((await (await attemptSaved).json()).attempt.correct).toBe(true);
  await expect(page.locator("#positionText")).toHaveText("2 / 6");

  const pictureEssay = data.essays[2];
  await categories.selectOption({ label: parsed.categories[2].name });
  await expect(page.locator("#positionText")).toHaveText("1 / 9");
  await expect(materials).not.toHaveAttribute("open", "");
  await preview.locator("summary").click();
  await page.locator("#showEnglish").uncheck();
  await expect(preview).toBeHidden();
  await materials.locator("summary").click();
  await expect(materials.locator(".writing-picture")).toHaveText([pictureEssay.material.english, pictureEssay.material.meaning]);

  const tableEssay = data.essays[6];
  await categories.selectOption({ label: parsed.categories[6].name });
  await materials.locator("summary").click();
  await expect(materials.getByRole("table", { name: tableEssay.material.caption })).toBeVisible();
  await expect(preview).toBeHidden();
  await page.locator("#showEnglish").check();
  await expect(preview).not.toHaveAttribute("open", "");
  await preview.locator("summary").click();
  await expect(preview.locator(".cet4-chinese .is-current")).toHaveText(tableEssay.paragraphs[0][0].meaning);
  await expect(page.locator(".alignment-path").first()).toBeVisible();
});

test("a mismatched graduate preview leaves the signed-in exercise usable", async ({ page }) => {
  const resource = "/api/content-resources/graduate-writing.json";
  const stale = structuredClone(data);
  stale.essays[6].paragraphs[0][0].meaning += "旧版译文。";
  await page.route(`**${resource}`, route => route.fulfill({ json: stale }));
  const response = page.waitForResponse(result => new URL(result.url()).pathname === resource);
  await signIn(page);
  expect((await response).ok()).toBe(true);
  await page.locator("#categorySelect").selectOption({ label: parsed.categories[6].name });
  await expect(page.locator(".cet4-position")).toHaveText("考研英语二·大作文");
  await expect(page.locator(".cet4-unavailable")).toBeVisible();
  await expect(page.locator(".graduate-materials, .cet4-preview")).toHaveCount(0);
  await expect(page.locator("#targetWord")).toHaveText(data.essays[6].paragraphs[0][0].english);
  await page.locator("#nextButton").click();
  await expect(page.locator("#positionText")).toHaveText("2 / 9");
  await expect(page.locator("#answerInput")).toBeEnabled();
});

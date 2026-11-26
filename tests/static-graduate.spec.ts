import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";

const source = JSON.parse(readFileSync("graduate-writing.json", "utf8"));
const parsed = require("../cet4-writing.js").parse(source);

for (const entry of ["/index.html", "/typing-practice.html"]) {
  test(`${entry} shows both graduate writing tracks and keeps chart data readable on mobile`, async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto(entry);
    await expect(page.locator("#answerInput")).toBeEnabled();
    const categories = page.locator("#categorySelect");
    const labels = await categories.locator("option").allTextContents();
    expect(labels.slice(-8)).toEqual(parsed.categories.map((category: { name: string }) => category.name));
    expect(labels.at(-9)).toMatch(/^高考读后续写：/);

    const tableEssay = source.essays[6];
    await categories.selectOption({ label: parsed.categories[6].name });
    await expect(page.locator("#positionText")).toHaveText("1 / 9");
    const materials = page.locator(".graduate-materials");
    const answer = page.locator(".cet4-preview");
    await answer.locator("summary").click();
    await page.locator("#showWord").uncheck();
    await expect(answer).toBeHidden();
    const summary = materials.locator("summary");
    await summary.focus();
    await summary.press("Enter");
    const table = materials.getByRole("table", { name: tableEssay.material.caption });
    await expect(table).toBeVisible();
    await expect(table.getByRole("columnheader")).toHaveText(tableEssay.material.columns);
    await expect(table.getByRole("rowheader")).toHaveText(tableEssay.material.rows.map((row: string[]) => row[0]));
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);

    await page.locator("#showWord").check();
    await answer.locator("summary").click();
    await expect(answer.locator(".cet4-english .is-current")).toHaveText(tableEssay.paragraphs[0][0].english);
    await page.locator("#nextBtn").click();
    await expect(answer.locator(".cet4-english .is-current")).toHaveText(tableEssay.paragraphs[0][1].english);
    await expect(materials).toHaveAttribute("open", "");
  });
}

test("a missing graduate resource leaves other standalone writing sets usable", async ({ page }) => {
  await page.route("**/graduate-writing.json", route => route.fulfill({ status: 503, body: "Unavailable" }));
  await page.goto("/index.html");
  await expect(page.locator("#loadStatus")).toContainText("考研作文暂未加载");
  await expect(page.locator("#categorySelect option").filter({ hasText: /^考研英语/ })).toHaveCount(0);
  await expect(page.locator("#categorySelect option").filter({ hasText: /^高考/ })).toHaveCount(10);
  await expect(page.locator("#answerInput")).toBeEnabled();
});

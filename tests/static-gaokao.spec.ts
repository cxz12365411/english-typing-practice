import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";

const data = JSON.parse(readFileSync("gaokao-writing.json", "utf8"));
const writing = require("../cet4-writing.js");
const application = data.essays[0];
const continuation = data.essays[6];

test("Gaokao has ten categories, 76 ordered sentences and reviewed mappings", () => {
  const parsed = writing.parse(data);
  expect(parsed.categories).toHaveLength(10);
  expect(parsed.items).toHaveLength(76);
  expect(parsed.items[0].key).toBe("gaokao-e01-s01");
  expect(parsed.items.at(-1).key).toBe("gaokao-e10-s10");
  const alignments = JSON.parse(readFileSync("sentence-alignments.json", "utf8")).entries;
  for (const item of parsed.items) {
    const entries = alignments.filter((entry: { english: string; meaning: string }) =>
      item.english === entry.english && item.meaning === entry.meaning
    );
    expect(entries, item.key).toHaveLength(1);
    expect(entries[0].groups.length, item.key).toBeGreaterThan(1);
  }
});

for (const entry of ["/index.html", "/typing-practice.html"]) {
  test(`${entry} opens Gaokao categories in order and keeps the prompt visible in hidden-English practice`, async ({ page }) => {
    if (entry === "/typing-practice.html") await page.setViewportSize({ width: 375, height: 812 });
    await page.goto(entry);
    await expect(page.locator("#answerInput")).toBeEnabled();
    const categories = page.locator("#categorySelect");
    const labels = await categories.locator("option").allTextContents();
    expect(labels.slice(-10)).toEqual(writing.parse(data).categories.map((category: { name: string }) => category.name));
    expect(labels.at(-11)).toMatch(/^六级句型：/);

    await categories.selectOption(`高考应用文：${application.title}`);
    await expect(page.locator("#positionText")).toHaveText("1 / 6");
    await expect(page.locator("#targetWord")).toHaveText(application.paragraphs[0][0].english);
    await categories.selectOption(`高考读后续写：${continuation.title}`);
    await expect(page.locator("#positionText")).toHaveText("1 / 10");
    await expect(page.locator(".alignment-path").first()).toBeVisible();
    const materials = page.locator(".gaokao-materials");
    const answer = page.locator(".cet4-preview");
    await answer.locator("summary").click();
    await page.locator("#showWord").uncheck();
    await expect(answer).toBeHidden();
    await expect(answer).not.toHaveAttribute("open", "");
    await expect(page.locator("#alignmentArrows")).toBeHidden();
    const summary = materials.locator("summary");
    await summary.focus();
    await summary.press("Enter");
    await expect(materials).toHaveAttribute("open", "");
    await expect(materials.locator(".gaokao-reading")).toHaveText(continuation.reading.english);
    await expect(materials.getByText(continuation.paragraphStarts[0].english)).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);

    await page.locator("#showWord").check();
    await answer.locator("summary").click();
    await page.locator("#nextBtn").click();
    await expect(answer.locator(".cet4-english .is-current")).toHaveText(continuation.paragraphs[0][1].english);
    await expect(materials).toHaveAttribute("open", "");
    await expect(page.locator("#positionText")).toHaveText("2 / 10");
  });
}

test("a missing Gaokao resource leaves the existing standalone corpus usable", async ({ page }) => {
  await page.route("**/gaokao-writing.json", route => route.fulfill({ status: 503, body: "Unavailable" }));
  await page.goto("/index.html");
  await expect(page.locator("#loadStatus")).toContainText("高考作文暂未加载");
  await expect(page.locator("#categorySelect option").filter({ hasText: /^高考/ })).toHaveCount(0);
  await expect(page.locator("#categorySelect option").filter({ hasText: /^六级作文：/ })).toHaveCount(6);
  await expect(page.locator("#answerInput")).toBeEnabled();
});

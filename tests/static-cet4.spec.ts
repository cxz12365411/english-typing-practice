import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";

const data = JSON.parse(readFileSync("cet4-writing.json", "utf8"));
const writing = require("../cet4-writing.js");
const alignment = require("../alignment.js");
const parsed = writing.parse(data);
const first = data.essays[0];
const firstSentence = first.paragraphs[0][0];

async function openEssay(page: Page, entry = "/index.html") {
  await page.goto(entry);
  await expect(page.locator("#answerInput")).toBeEnabled();
  await page.locator("#categorySelect").selectOption(`四级作文：${first.title}`);
  await expect(page.locator("#targetWord")).toHaveText(firstSentence.english);
  await expect(page.locator(".cet4-preview summary")).toBeVisible();
}

test("original writing corpus has 10 complete essays, 40 expressions and reviewed alignments", () => {
  expect(data.essays).toHaveLength(10);
  expect(data.expressionGroups).toHaveLength(4);
  expect(parsed.categories).toHaveLength(14);
  for (const essay of data.essays) {
    const count = writing.wordCount(essay.paragraphs.flat().map((sentence: any) => sentence.english).join(" "));
    expect(count, essay.title).toBeGreaterThanOrEqual(120);
    expect(count, essay.title).toBeLessThanOrEqual(180);
    expect(essay.paragraphs).toHaveLength(3);
  }
  for (const group of data.expressionGroups) expect(group.items).toHaveLength(10);
  expect(new Set(parsed.items.map((item: any) => item.key)).size).toBe(parsed.items.length);
  expect(new Set(parsed.items.map((item: any) => item.english)).size).toBe(parsed.items.length);
  const alignments = JSON.parse(readFileSync("sentence-alignments.json", "utf8")).entries;
  for (const item of parsed.items) {
    const matches = alignments.filter((entry: any) => entry.english === item.english && entry.meaning === item.meaning);
    expect(matches, item.english).toHaveLength(1);
    expect(alignment.validateEntry(matches[0]), item.english).toBe(true);
    expect(matches[0].groups.length, item.english).toBeGreaterThan(1);
  }
  const oldSource = readFileSync("daily-english-high-frequency-sentences.md", "utf8");
  for (const item of parsed.items) expect(oldSource.includes(`| ${item.english}<br>`), item.english).toBe(false);
});

for (const entry of ["/index.html", "/typing-practice.html"]) {
  test(`${entry}: full essay, keyboard, hidden English and sentence order preserve practice`, async ({ page }) => {
    await openEssay(page, entry);
    await page.locator("#answerInput").fill("draft answer");
    const summary = page.locator(".cet4-preview summary");
    await summary.focus();
    await page.keyboard.press("Enter");
    await expect(page.locator(".cet4-preview")).toHaveAttribute("open", "");
    await expect(page.locator("#answerInput")).toHaveValue("draft answer");
    await expect(page.locator(".cet4-english .is-current")).toHaveText(firstSentence.english);
    await expect(page.locator(".cet4-source")).toContainText("原创参考范文");
    await expect(page.locator(".alignment-path").first()).toBeVisible();
    if (entry === "/index.html") await page.screenshot({ path: "out/cet4-static-desktop.png", fullPage: true });
    await page.locator("#nextBtn").click();
    await expect(page.locator("#targetWord")).toHaveText(first.paragraphs[0][1].english);
    await expect(page.locator(".cet4-preview")).toHaveAttribute("open", "");
    await page.locator("#showWord").uncheck();
    await expect(page.locator(".cet4-preview")).toBeHidden();
    await expect(page.locator("#alignmentArrows")).toBeHidden();
    await page.locator("#showWord").check();
    await expect(page.locator(".cet4-preview")).not.toHaveAttribute("open", "");
    await summary.click();
    await page.locator("#categorySelect").selectOption(`四级作文：${data.essays[1].title}`);
    await expect(page.locator(".cet4-preview")).not.toHaveAttribute("open", "");
    await page.locator("#categorySelect").selectOption(`四级句型：${data.expressionGroups[0].title}`);
    await expect(page.locator("#cet4Writing")).toBeHidden();
  });
}

test("375px full essay wraps while long sentence arrows scroll internally", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await openEssay(page);
  await page.locator(".cet4-preview summary").click();
  await expect(page.locator(".cet4-english").first()).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: "out/cet4-static-mobile.png", fullPage: true });
  await page.setViewportSize({ width: 900, height: 700 });
  await expect(page.locator(".alignment-path").first()).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test("unavailable writing resource leaves the original corpus usable", async ({ page }) => {
  await page.route("**/cet4-writing.json", route => route.fulfill({ status: 503, body: "Unavailable" }));
  await page.goto("/index.html");
  await expect(page.locator("#answerInput")).toBeEnabled();
  await expect(page.locator("#loadStatus")).toContainText("四级作文暂未加载");
  await expect(page.locator("#cet4Writing")).toBeHidden();
  await expect(page.locator("#targetWord")).not.toHaveText("");
});

test("malformed writing content is rejected without losing the original corpus", async ({ page }) => {
  await page.route("**/cet4-writing.json", route => route.fulfill({ contentType: "application/json", body: JSON.stringify({ ...data, essays: data.essays.slice(0, 9) }) }));
  await page.goto("/index.html");
  await expect(page.locator("#answerInput")).toBeEnabled();
  await expect(page.locator("#loadStatus")).toContainText("四级作文暂未加载");
  expect(await page.locator("#categorySelect option").count()).toBe(27);
});

test("browsers without AbortSignal.timeout still load and practice writing", async ({ page }) => {
  await page.addInitScript(() => Object.defineProperty(AbortSignal, "timeout", { configurable: true, value: undefined }));
  await openEssay(page);
  await expect(page.locator("#targetWord")).toHaveText(firstSentence.english);
});

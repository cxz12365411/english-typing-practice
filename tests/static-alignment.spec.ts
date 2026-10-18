import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";

type AlignmentEntry = {
  english: string;
  meaning: string;
  zhParts: string[];
  groups: { en: number[]; zh: number[]; note?: string }[];
};
type AlignmentData = { version: number; entries: AlignmentEntry[] };
const api = require("../alignment.js") as {
  tokenize(text: string): { text: string; start: number; end: number }[];
  key(english: string, meaning: string): string;
  validateEntry(entry: unknown): boolean;
};
const hey: AlignmentEntry = {
  english: "Hey, is this seat taken?",
  meaning: "嗨，这个位子有人坐吗？",
  zhParts: ["嗨", "，", "这个", "位子", "有人坐吗", "？"],
  groups: [
    { en: [0], zh: [0] },
    { en: [1, 4], zh: [4], note: "is … taken 是被动疑问表达，在座位语境中合译为“有人坐吗”。" },
    { en: [2], zh: [2] },
    { en: [3], zh: [3] }
  ]
};
const separateTargets: AlignmentEntry = {
  english: "I am interested in ____.",
  meaning: "我对____感兴趣。",
  zhParts: ["我", "对", "____", "感兴趣", "。"],
  groups: [
    { en: [0], zh: [0] },
    { en: [1, 2, 3], zh: [1, 3], note: "be interested in 合译为“对……感兴趣”。" },
    { en: [4], zh: [2] }
  ]
};
const words = "## 1. 测试 3 个\n- **apple**：苹果\n- **book**：书；书籍\n- **cat**：猫\n";
const defaultEntries = [hey, separateTargets];

function sentenceMarkdown(entries: AlignmentEntry[]) {
  return "## 1. 测试箭头\n| English | 中文 |\n|---|---|\n" + entries.map(entry => `| ${entry.english} | ${entry.meaning} |`).join("\n");
}

async function openPractice(page: Page, options: {
  entries?: AlignmentEntry[];
  data?: AlignmentData;
  unavailable?: boolean;
  unavailableAsset?: "css" | "js";
  delay?: Promise<void>;
  entry?: string;
} = {}) {
  const entries = options.entries ?? defaultEntries;
  await page.addInitScript(() => {
    const w = window as any;
    // Tests inspect text, geometry and scoring without emitting real audio.
    Object.defineProperty(w, "speechSynthesis", {
      configurable: true,
      value: { getVoices: () => [], addEventListener() {}, removeEventListener() {}, cancel() {}, speak() {} }
    });
    w.SpeechSynthesisUtterance = class { constructor(public text: string) {} };
  });
  await page.route("**/basic-english-850.md", route => route.fulfill({ contentType: "text/markdown", body: words }));
  await page.route("**/daily-english-high-frequency-sentences.md", route => route.fulfill({ contentType: "text/markdown", body: sentenceMarkdown(entries) }));
  await page.route("**/sentence-alignments.json", async route => {
    if (options.delay) await options.delay;
    if (options.unavailable) return route.fulfill({ status: 404, body: "Missing" });
    return route.fulfill({ contentType: "application/json", body: JSON.stringify(options.data ?? { version: 1, entries }) });
  });
  if (options.unavailableAsset) {
    await page.route(`**/alignment.${options.unavailableAsset}*`, route => route.abort("failed"));
  }
  await page.goto(options.entry ?? "/index.html");
  await expect(page.locator("#answerInput")).toBeEnabled();
  await expect(page.locator("#targetWord")).toHaveText("apple");
}

async function selectSentences(page: Page) {
  await page.locator("#categorySelect").selectOption("句型：测试箭头");
}

async function activeEnglish(page: Page) {
  return page.locator(".alignment-token.is-highlighted").allTextContents();
}

async function geometryErrors(page: Page) {
  return page.evaluate(() => {
    const stage = document.querySelector("#alignmentStage")!.getBoundingClientRect();
    return Array.from(document.querySelectorAll<SVGPathElement>(".alignment-path")).flatMap(path => {
      const token = document.querySelector<HTMLElement>(`.alignment-token[data-en-index="${path.dataset.enIndex}"]`)!.getBoundingClientRect();
      const ids = path.dataset.zhIndices!.split(",");
      const first = document.querySelector<HTMLElement>(`.alignment-zh[data-zh-index="${ids[0]}"]`)!.getBoundingClientRect();
      const last = document.querySelector<HTMLElement>(`.alignment-zh[data-zh-index="${ids.at(-1)}"]`)!.getBoundingClientRect();
      const start = path.getPointAtLength(0);
      const end = path.getPointAtLength(path.getTotalLength());
      const errors: string[] = [];
      if (Math.abs(start.x - (token.left + token.width / 2 - stage.left)) > 1) errors.push("source x");
      if (Math.abs(start.y - (token.bottom - stage.top + 7)) > 1) errors.push("source y");
      if (end.x < first.left - stage.left - 1 || end.x > last.right - stage.left + 1) errors.push("target x");
      if (Math.abs(end.y - (first.top - stage.top - 9)) > 1) errors.push("target y");
      return errors;
    });
  });
}

test("all 270 sentence entries exactly cover the source and validate every token and Chinese fragment", () => {
  const data = JSON.parse(readFileSync("sentence-alignments.json", "utf8")) as AlignmentData;
  const source = readFileSync("daily-english-high-frequency-sentences.md", "utf8").split(/\r?\n/)
    .filter(line => line.startsWith("|") && line.includes("<br>"))
    .map(line => {
      const cells = line.slice(1, -1).split("|").map(cell => cell.trim());
      return { english: cells[0].split("<br>")[0], meaning: cells[1] };
    });
  expect(data.version).toBe(1);
  expect(source).toHaveLength(270);
  expect(data.entries).toHaveLength(270);
  const expectedKeys = source.map(entry => api.key(entry.english, entry.meaning)).sort();
  expect(data.entries.map(entry => api.key(entry.english, entry.meaning)).sort()).toEqual(expectedKeys);
  expect(new Set(expectedKeys).size).toBe(270);
  for (const entry of data.entries) {
    expect(api.validateEntry(entry), entry.english).toBe(true);
    expect(entry.zhParts.join(""), entry.english).toBe(entry.meaning);
    expect(entry.groups.flatMap(group => group.en).sort((a, b) => a - b), entry.english)
      .toEqual(api.tokenize(entry.english).map((_, index) => index));
  }
  expect(api.tokenize("I'll try black-and-white at 10:30 with ____ and I’m ready.").map(token => token.text))
    .toEqual(["I'll", "try", "black-and-white", "at", "10", "30", "with", "____", "and", "I’m", "ready"]);
});

test("all 850 words retain their complete meaning and render exactly one arrow", async ({ page }) => {
  const wordItems = Array.from(readFileSync("basic-english-850.md", "utf8").matchAll(/^- \*\*(.+?)\*\*：(.+)$/gm), match => ({
    word: match[1].trim(), meaning: match[2].trim(), kind: "word"
  }));
  expect(wordItems).toHaveLength(850);
  await openPractice(page);
  const failures = await page.evaluate(items => {
    const renderer = eval("alignmentRenderer");
    const failures: string[] = [];
    for (const item of items) {
      renderer.render(item);
      renderer.draw();
      if (document.querySelector("#targetWord")!.textContent !== item.word
        || document.querySelector("#meaningText")!.textContent !== item.meaning
        || document.querySelectorAll(".alignment-token").length !== 1
        || document.querySelectorAll(".alignment-path").length !== 1) failures.push(item.word);
    }
    return failures;
  }, wordItems);
  expect(failures).toEqual([]);
});

test("the screenshot sentence preserves punctuation and links is and taken to the same Chinese phrase", async ({ page }) => {
  await openPractice(page);
  await selectSentences(page);
  await expect(page.locator("#targetWord")).toHaveText(hey.english);
  await expect(page.locator("#meaningText")).toHaveText(hey.meaning);
  await expect(page.locator(".alignment-token")).toHaveCount(5);
  await expect(page.locator(".alignment-path")).toHaveCount(5);
  await expect(page.locator('.alignment-token[data-en-index="0"]')).toHaveAttribute("aria-label", "Hey，对应：嗨");
  await page.locator('.alignment-token[data-en-index="1"]').click();
  expect(await activeEnglish(page)).toEqual(["is", "taken"]);
  await expect(page.locator(".alignment-zh.is-highlighted")).toHaveText("有人坐吗");
  await expect(page.locator(".alignment-path.is-highlighted")).toHaveCount(2);
  await expect(page.locator("#alignmentNote")).toContainText("被动疑问");
  await expect.poll(() => geometryErrors(page)).toEqual([]);
});

test("hover, click, keyboard focus and Escape select and clear linked groups", async ({ page }) => {
  await openPractice(page);
  await selectSentences(page);
  const heyWord = page.locator('.alignment-token[data-en-index="0"]');
  const seat = page.locator('.alignment-token[data-en-index="3"]');
  await heyWord.hover();
  expect(await activeEnglish(page)).toEqual(["Hey"]);
  await expect(page.locator("#alignmentStage")).toHaveClass(/has-highlight/);
  // The pointer remains over Hey while keyboard navigation moves to is.
  await heyWord.focus();
  await page.keyboard.press("Tab");
  expect(await activeEnglish(page)).toEqual(["is", "taken"]);
  await seat.click();
  await page.locator("#answerInput").hover();
  await page.locator("#answerInput").focus();
  expect(await activeEnglish(page)).toEqual(["seat"]);
  await heyWord.focus();
  await page.keyboard.press("Tab");
  expect(await activeEnglish(page)).toEqual(["is", "taken"]);
  await page.keyboard.press("Enter");
  await page.locator("#answerInput").focus();
  expect(await activeEnglish(page)).toEqual(["is", "taken"]);
  await page.locator("#alignmentScroll").focus();
  await page.keyboard.press("Escape");
  await expect(page.locator("#alignmentStage")).not.toHaveClass(/has-highlight/);
  await expect(page.locator(".alignment-token.is-highlighted")).toHaveCount(0);
  await expect(page.locator(".alignment-path.is-highlighted")).toHaveCount(0);
  await expect(page.locator("#alignmentNote")).not.toContainText("被动疑问");
});

test("the arrow preference survives refresh and toggling never resets an answer in progress", async ({ page }) => {
  await openPractice(page, { entry: "/typing-practice.html" });
  await expect(page.locator("#showAlignment")).toBeChecked();
  await selectSentences(page);
  await page.locator("#answerInput").fill("Hey,");
  await page.locator("#showAlignment").uncheck();
  await expect(page.locator("#answerInput")).toHaveValue("Hey,");
  await expect(page.locator(".alignment-token")).toHaveCount(0);
  await expect(page.locator(".alignment-path")).toHaveCount(0);
  await expect(page.locator("#alignmentNote")).toBeHidden();
  expect(await page.evaluate(() => localStorage.getItem("basicTypingAlignmentEnabled"))).toBe("false");
  await page.reload();
  await expect(page.locator("#showAlignment")).not.toBeChecked();
  await expect(page.locator(".alignment-path")).toHaveCount(0);
  await page.locator("#showAlignment").check();
  await expect(page.locator(".alignment-path")).toHaveCount(1);
  await page.reload();
  await expect(page.locator("#showAlignment")).toBeChecked();
  await expect(page.locator(".alignment-path")).toHaveCount(1);
});

test("hiding English removes tokens, arrows, accessible hints and the selected explanation", async ({ page }) => {
  await openPractice(page);
  await selectSentences(page);
  await page.locator('.alignment-token[data-en-index="1"]').click();
  await page.locator("#answerInput").fill("Hey,");
  await page.locator("#showWord").uncheck();
  await expect(page.locator("#targetWord")).toHaveText("•".repeat(hey.english.length));
  await expect(page.locator("#meaningText")).toHaveText(hey.meaning);
  await expect(page.locator("#answerInput")).toHaveValue("Hey,");
  await expect(page.locator(".alignment-token, .alignment-path")).toHaveCount(0);
  await expect(page.locator("#alignmentScroll [aria-label]")).toHaveCount(0);
  await expect(page.locator("#alignmentScroll")).not.toHaveAttribute("aria-label");
  await expect(page.locator("#alignmentNote")).toBeEmpty();
  await expect(page.locator("#alignmentNote")).toBeHidden();
  await page.locator("#showAlignment").uncheck();
  await page.locator("#showAlignment").check();
  await expect(page.locator(".alignment-token, .alignment-path")).toHaveCount(0);
  await page.locator("#showWord").check();
  await expect(page.locator(".alignment-path")).toHaveCount(5);
});

test("late alignment data decorates the current prompt without changing input, grading or focus", async ({ page }) => {
  let release!: () => void;
  const delay = new Promise<void>(resolve => { release = resolve; });
  await openPractice(page, { delay });
  await selectSentences(page);
  await expect(page.locator(".alignment-path")).toHaveCount(0);
  await page.locator("#answerInput").fill("Hey, is");
  const before = await page.locator("#letters").textContent();
  release();
  await expect(page.locator(".alignment-path")).toHaveCount(5);
  await expect(page.locator("#answerInput")).toHaveValue("Hey, is");
  await expect(page.locator("#answerInput")).toBeFocused();
  await expect(page.locator("#letters")).toHaveText(before!);
  await expect(page.locator("#doneStat")).toHaveText("0");
  await expect(page.locator("#mistakeStat")).toHaveText("0");
});

for (const scenario of ["missing", "mismatched", "invalid"] as const) {
  test(`${scenario} sentence data falls back to unchanged plain text while typing remains usable`, async ({ page }) => {
    const invalid = { ...hey, groups: [{ en: [0], zh: [0] }] };
    const mismatched = { ...hey, english: hey.english.replace("Hey", "Hello") };
    await openPractice(page, {
      unavailable: scenario === "missing",
      data: { version: 1, entries: [scenario === "invalid" ? invalid : mismatched] }
    });
    await selectSentences(page);
    await expect(page.locator("#targetWord")).toHaveText(hey.english);
    await expect(page.locator("#meaningText")).toHaveText(hey.meaning);
    await expect(page.locator(".alignment-token, .alignment-path")).toHaveCount(0);
    await expect(page.locator("#alignmentNote")).toBeHidden();
    await page.locator("#answerInput").fill("Hey");
    await expect(page.locator("#answerInput")).toHaveValue("Hey");
    await page.locator("#categorySelect").selectOption("单词：测试");
    await expect(page.locator(".alignment-path")).toHaveCount(1);
  });
}

test("noncontiguous Chinese targets receive separate arrows rather than a midpoint over unrelated text", async ({ page }) => {
  expect(api.validateEntry(separateTargets)).toBe(true);
  await openPractice(page, { entries: [separateTargets] });
  await selectSentences(page);
  await expect(page.locator(".alignment-path")).toHaveCount(8);
  const destinations = await page.locator('.alignment-path[data-en-index="1"]').evaluateAll(paths => paths.map(path => (path as SVGPathElement).dataset.zhIndices));
  expect(destinations).toEqual(["1", "3"]);
  await expect(page.locator('.alignment-path[data-en-index="1"][data-zh-indices="1,2,3"]')).toHaveCount(0);
  await expect.poll(() => geometryErrors(page)).toEqual([]);
  await page.locator('.alignment-token[data-en-index="2"]').click();
  await expect(page.locator('.alignment-zh[data-zh-index="2"]')).not.toHaveClass(/is-highlighted/);
  await expect(page.locator(".alignment-zh.is-highlighted")).toHaveText(["对", "感兴趣"]);
});

test("375px pages scroll only inside the diagram and keep arrow endpoints correct after resize and scrolling", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await openPractice(page);
  await selectSentences(page);
  await expect(page.locator(".alignment-path")).toHaveCount(5);
  const sizes = await page.evaluate(() => {
    const scroll = document.querySelector<HTMLElement>("#alignmentScroll")!;
    return { page: document.documentElement.scrollWidth, viewport: innerWidth, diagram: scroll.scrollWidth, available: scroll.clientWidth };
  });
  expect(sizes.page).toBeLessThanOrEqual(sizes.viewport);
  expect(sizes.diagram).toBeGreaterThan(sizes.available);
  await page.locator("#alignmentScroll").evaluate(element => { element.scrollLeft = element.scrollWidth; });
  expect(await page.locator("#alignmentScroll").evaluate(element => element.scrollLeft)).toBeGreaterThan(0);
  await expect.poll(() => geometryErrors(page)).toEqual([]);
  const before = await page.locator("#alignmentArrows").getAttribute("viewBox");
  await page.setViewportSize({ width: 1280, height: 900 });
  await expect.poll(() => page.locator("#alignmentArrows").getAttribute("viewBox")).not.toBe(before);
  await expect.poll(() => geometryErrors(page)).toEqual([]);
});

test("rapid question changes discard old paths, notes and scroll position", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await openPractice(page);
  await selectSentences(page);
  await page.locator('.alignment-token[data-en-index="1"]').click();
  await page.locator("#alignmentScroll").evaluate(element => { element.scrollLeft = 100; });
  await page.locator("#nextBtn").click();
  await expect(page.locator("#targetWord")).toHaveText(separateTargets.english);
  await expect(page.locator(".alignment-path")).toHaveCount(8);
  await expect(page.locator("#alignmentNote")).not.toContainText("被动疑问");
  expect(await page.locator("#alignmentScroll").evaluate(element => element.scrollLeft)).toBe(0);
  await page.evaluate(() => { for (let index = 0; index < 5; index++) (document.querySelector("#nextBtn") as HTMLButtonElement).click(); });
  await expect(page.locator("#targetWord")).toHaveText(hey.english);
  await expect(page.locator(".alignment-path")).toHaveCount(5);
  await expect(page.locator(".alignment-token")).toHaveText(["Hey", "is", "this", "seat", "taken"]);
  await expect(page.locator(".alignment-path.is-highlighted")).toHaveCount(0);
  await expect.poll(() => geometryErrors(page)).toEqual([]);
});

test("correct scoring and mistake keys still use the original full sentence", async ({ page }) => {
  await openPractice(page);
  await selectSentences(page);
  await page.locator('.alignment-token[data-en-index="3"]').click();
  await page.locator("#answerInput").fill("wrong answer");
  await page.locator("#answerInput").press("Enter");
  await expect(page.locator("#mistakeStat")).toHaveText("1");
  await expect(page.locator("#feedback")).toContainText(hey.english);
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("basicTypingMistakes")!))).toEqual([hey.english]);
  await page.locator("#showAlignment").uncheck();
  await expect(page.locator("#answerInput")).toHaveValue("wrong answer");
  await page.locator("#answerInput").fill(hey.english);
  await expect(page.locator("#doneStat")).toHaveText("1");
  await expect(page.locator("#mistakeStat")).toHaveText("0");
  await expect(page.locator("#accuracyStat")).toHaveText("0%");
  await expect(page.locator("#targetWord")).toHaveText(separateTargets.english);
  await page.locator("#answerInput").fill(separateTargets.english);
  await expect(page.locator("#doneStat")).toHaveText("2");
  await expect(page.locator("#accuracyStat")).toHaveText("50%");
  await expect(page.locator("#streakStat")).toHaveText("1");
});

for (const unavailableAsset of ["css", "js"] as const) {
  test(`${unavailableAsset.toUpperCase()} loading failure disables arrows and preserves a stable usable plain prompt`, async ({ page }) => {
    await openPractice(page, { unavailableAsset });
    await expect(page.locator("#showAlignment")).toBeDisabled();
    await expect(page.locator("#targetWord")).toHaveText("apple");
    await expect(page.locator("#meaningText")).toHaveText("苹果");
    await selectSentences(page);
    await expect(page.locator("#targetWord")).toHaveText(hey.english);
    await expect(page.locator("#meaningText")).toHaveText(hey.meaning);
    await expect(page.locator(".alignment-token, .alignment-path")).toHaveCount(0);
    await expect(page.locator("#alignmentArrows")).toBeHidden();
    await expect(page.locator("#alignmentNote")).toBeHidden();
    const before = await page.locator("#alignmentStage").boundingBox();
    await page.locator("#answerInput").fill("Hey, is");
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    const after = await page.locator("#alignmentStage").boundingBox();
    expect(after?.height).toBe(before?.height);
    expect(after?.height).toBeLessThan(150);
    await expect(page.locator("#answerInput")).toHaveValue("Hey, is");
    await page.locator("#answerInput").fill(hey.english);
    await expect(page.locator("#doneStat")).toHaveText("1");
    await expect(page.locator("#accuracyStat")).toHaveText("100%");
  });
}

test("the longest real sentence keeps all text and words linked inside the mobile diagram", async ({ page }) => {
  const data = JSON.parse(readFileSync("sentence-alignments.json", "utf8")) as AlignmentData;
  const longest = [...data.entries].sort((a, b) => b.english.length - a.english.length)[0];
  const count = api.tokenize(longest.english).length;
  await page.setViewportSize({ width: 375, height: 812 });
  await openPractice(page, { entries: [longest] });
  await selectSentences(page);
  await expect(page.locator("#targetWord")).toHaveText(longest.english);
  await expect(page.locator("#meaningText")).toHaveText(longest.meaning);
  await expect(page.locator(".alignment-token")).toHaveCount(count);
  await expect.poll(() => page.locator(".alignment-path").evaluateAll(paths => new Set(paths.map(path => (path as SVGPathElement).dataset.enIndex)).size)).toBe(count);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
  await expect.poll(() => geometryErrors(page)).toEqual([]);
});

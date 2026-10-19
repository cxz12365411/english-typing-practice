import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";

const writing = JSON.parse(readFileSync("cet4-writing.json", "utf8"));
const essay = writing.essays[0];
const firstSentence = essay.paragraphs[0][0];
const storageKey = "basicTypingLayoutSettings";

async function width(page: Page, selector = ".practice-layout") {
  return page.locator(selector).evaluate(element => element.getBoundingClientRect().width);
}

async function openPractice(page: Page, entry = "/index.html") {
  await page.goto(entry);
  await expect(page.locator("#answerInput")).toBeEnabled();
  await expect(page.locator("[data-layout-reset]")).toBeVisible();
}

async function drag(page: Page, handle: "left" | "right" | "split", delta: number, release = true) {
  const locator = page.locator(`[data-layout-handle="${handle}"]`);
  await expect(locator).toBeVisible();
  let bounds = await locator.boundingBox();
  if (!bounds) throw new Error(`Missing ${handle} drag handle`);
  const viewportHeight = page.viewportSize()!.height;
  if (bounds.y + bounds.height <= 0 || bounds.y >= viewportHeight) {
    await locator.scrollIntoViewIfNeeded();
    bounds = (await locator.boundingBox())!;
  }
  // Expanded essays can scroll the page while a tall edge remains partly visible.
  const visibleTop = Math.max(0, bounds.y);
  const visibleBottom = Math.min(viewportHeight, bounds.y + bounds.height);
  const start = { x: bounds.x + bounds.width / 2, y: (visibleTop + visibleBottom) / 2 };
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(start.x + delta, start.y, { steps: 6 });
  if (release) await page.mouse.up();
  return start;
}

async function expectWidth(page: Page, expected: number, selector = ".practice-layout") {
  await expect.poll(async () => Math.abs(await width(page, selector) - expected)).toBeLessThan(2);
}

async function expectNoOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  const shell = await page.locator(".practice-layout").boundingBox();
  const controls = page.locator("#categorySelect, #orderSelect, #resetBtn, #speakBtn, #nextBtn, #voiceSelect, #previewVoiceBtn");
  for (const control of await controls.all()) {
    const box = await control.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(shell!.x);
    expect(box!.x + box!.width).toBeLessThanOrEqual(shell!.x + shell!.width + 1);
  }
}

for (const entry of ["/index.html", "/typing-practice.html"]) {
  test(`${entry}: both edges and divider resize without changing an in-progress essay`, async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await openPractice(page, entry);
    await expectWidth(page, 1408);
    await expectWidth(page, 300, ".side");
    await page.locator("#categorySelect").selectOption(`四级作文：${essay.title}`);
    await expect(page.locator("#targetWord")).toHaveText(firstSentence.english);
    await page.locator(".cet4-preview summary").click();
    await page.locator("#answerInput").fill("keep my draft");
    const initialPosition = await page.locator("#positionText").textContent();
    const initialDone = await page.locator("#doneStat").textContent();
    const oldScrollWidth = await width(page, "#alignmentScroll");

    await drag(page, "right", -104);
    await expectWidth(page, 1200);
    await drag(page, "left", 50);
    await expectWidth(page, 1100);
    const shell = await page.locator(".practice-layout").boundingBox();
    expect(Math.abs(shell!.x - (1440 - shell!.width) / 2)).toBeLessThan(2);
    await drag(page, "split", -40);
    await expectWidth(page, 340, ".side");
    expect(await width(page, "#alignmentScroll")).toBeLessThan(oldScrollWidth);
    await expect(page.locator(".alignment-path").first()).toBeVisible();
    await expect(page.locator("#answerInput")).toHaveValue("keep my draft");
    await expect(page.locator("#targetWord")).toHaveText(firstSentence.english);
    await expect(page.locator(".cet4-preview")).toHaveAttribute("open", "");
    await expect(page.locator("#positionText")).toHaveText(initialPosition!);
    await expect(page.locator("#doneStat")).toHaveText(initialDone!);
    await expectNoOverflow(page);
    if (entry === "/index.html") await page.screenshot({ path: "out/layout-static-wide.png", fullPage: true });

    await page.locator("[data-layout-reset]").click();
    await expectWidth(page, 1408);
    await expectWidth(page, 300, ".side");
    await expect(page.locator("#answerInput")).toHaveValue("keep my draft");
    await expect(page.locator(".cet4-preview")).toHaveAttribute("open", "");
  });
}

test("saved layout survives refresh and a temporary small viewport", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await openPractice(page);
  await drag(page, "right", -104);
  await drag(page, "split", -60);
  await expectWidth(page, 1200);
  await expectWidth(page, 360, ".side");
  const saved = await page.evaluate(key => localStorage.getItem(key), storageKey);
  expect(JSON.parse(saved!)).toMatchObject({ version: 1, pageWidth: 1200, sideWidth: 360 });
  await page.reload();
  await expect(page.locator("#answerInput")).toBeEnabled();
  await expectWidth(page, 1200);
  await expectWidth(page, 360, ".side");

  await page.setViewportSize({ width: 900, height: 800 });
  await expect(page.locator('[data-layout-handle="right"]')).toBeHidden();
  await expect(page.locator('[data-layout-handle="split"]')).toBeHidden();
  await expect(page.locator(".practice-layout")).toHaveClass(/layout-stacked/);
  await expectWidth(page, 880);
  expect(await page.evaluate(key => localStorage.getItem(key), storageKey)).toBe(saved);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await expectWidth(page, 1200);
  await expectWidth(page, 360, ".side");
});

test("keyboard handles adjust by 16px and enforce page and column bounds", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await openPractice(page);
  const right = page.locator('[data-layout-handle="right"]');
  await right.focus();
  await page.keyboard.press("ArrowLeft");
  await expectWidth(page, 1392);
  await page.keyboard.press("ArrowRight");
  await expectWidth(page, 1408);
  const left = page.locator('[data-layout-handle="left"]');
  await left.focus();
  await page.keyboard.press("ArrowRight");
  await expectWidth(page, 1392);
  await page.locator('[data-layout-handle="split"]').focus();
  await page.keyboard.press("ArrowLeft");
  await expectWidth(page, 316, ".side");
  await drag(page, "split", -1000);
  await expectWidth(page, 480, ".side");
  expect(await width(page, ".main")).toBeGreaterThanOrEqual(480);
  await drag(page, "split", 1000);
  await expectWidth(page, 220, ".side");
  await drag(page, "right", -1000);
  await expectWidth(page, 760);
  await expect(page.locator(".practice-layout")).toHaveClass(/layout-stacked/);
  await expect(page.locator('[data-layout-handle="split"]')).toBeHidden();
  await expectNoOverflow(page);
  await drag(page, "right", 1000);
  await expectWidth(page, 1408);
  await expectNoOverflow(page);
});

for (const requested of [760, 1000, 1180]) {
  test(`a ${requested}px shell responds to its own width inside a wide window`, async ({ page }) => {
    await page.setViewportSize({ width: 1600, height: 1000 });
    await page.addInitScript(({ key, pageWidth }) => {
      localStorage.setItem(key, JSON.stringify({ version: 1, pageWidth, sideWidth: 300 }));
    }, { key: storageKey, pageWidth: requested });
    await openPractice(page);
    await expectWidth(page, requested);
    if (requested < 1100) await expect(page.locator(".practice-layout")).toHaveClass(/layout-compact/);
    if (requested === 760) await expect(page.locator(".practice-layout")).toHaveClass(/layout-stacked/);
    if (requested === 1180) await expect(page.locator(".practice-layout")).not.toHaveClass(/layout-compact/);
    await expectNoOverflow(page);
    if (requested !== 760) expect(await width(page, ".main")).toBeGreaterThanOrEqual(480);
    if (requested === 760) await page.screenshot({ path: "out/layout-static-narrow.png", fullPage: true });
  });
}

test("375px essay stays inside the page and keeps arrows internally scrollable", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await openPractice(page);
  await page.locator("#categorySelect").selectOption(`四级作文：${essay.title}`);
  await page.locator(".cet4-preview summary").click();
  await expect(page.locator(".practice-layout")).toHaveClass(/layout-small/);
  for (const handle of ["left", "right", "split"]) await expect(page.locator(`[data-layout-handle="${handle}"]`)).toBeHidden();
  await expectNoOverflow(page);
  const scroll = await page.locator("#alignmentScroll").evaluate(element => ({ client: element.clientWidth, scroll: element.scrollWidth }));
  expect(scroll.scroll).toBeGreaterThan(scroll.client);
  await expect(page.locator(".cet4-english").first()).toBeVisible();
  await page.screenshot({ path: "out/layout-static-mobile.png", fullPage: true });
});

test("pointer cancellation releases drag state and ignores later pointer movement", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await openPractice(page);
  const start = await drag(page, "right", -80, false);
  await page.locator('[data-layout-handle="right"]').dispatchEvent("pointercancel", { pointerId: 1, pointerType: "mouse", bubbles: true });
  await expect(page.locator(".practice-layout-dragging")).toHaveCount(0);
  await expectWidth(page, 1408);
  const stoppedWidth = await width(page);
  await page.mouse.move(start.x - 180, start.y);
  await page.mouse.up();
  await expectWidth(page, stoppedWidth);
  await page.locator('[data-layout-handle="right"]').focus();
  await page.keyboard.press("ArrowLeft");
  await expectWidth(page, stoppedWidth - 16);
});

test("layout still works when browser storage rejects preference reads and writes", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.addInitScript(key => {
    const get = Storage.prototype.getItem;
    const set = Storage.prototype.setItem;
    const remove = Storage.prototype.removeItem;
    Storage.prototype.getItem = function (name) { if (name === key) throw new DOMException("Blocked", "SecurityError"); return get.call(this, name); };
    Storage.prototype.setItem = function (name, value) { if (name === key) throw new DOMException("Blocked", "SecurityError"); return set.call(this, name, value); };
    Storage.prototype.removeItem = function (name) { if (name === key) throw new DOMException("Blocked", "SecurityError"); return remove.call(this, name); };
  }, storageKey);
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await openPractice(page);
  await page.locator("#answerInput").fill("draft");
  await drag(page, "right", -104);
  await expectWidth(page, 1200);
  await page.locator("[data-layout-reset]").click();
  await expectWidth(page, 1408);
  await expect(page.locator("#answerInput")).toHaveValue("draft");
  expect(errors).toEqual([]);
});

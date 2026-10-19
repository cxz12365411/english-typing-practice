import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";

const writing = require("../cet4-writing.js");
const source = JSON.parse(readFileSync("cet4-writing.json", "utf8"));
const parsed = writing.parse(source);
const essay = source.essays[0];
const first = essay.paragraphs[0][0];
const storageKey = "basicTypingLayoutSettings";

async function mockPractice(page: Page) {
  const categories = parsed.categories.map((category: any) => ({ ...category, id: category.slug }));
  const items = parsed.items.map((item: any) => ({ ...item, id: item.key, categoryId: item.categorySlug, revision: 1 }));
  let sessions = 0;
  let attempts = 0;
  let loggedOut = false;
  await page.route("**/api/**", route => {
    const path = new URL(route.request().url()).pathname;
    let body: unknown;
    if (path === "/api/auth/session") body = { user: loggedOut ? null : { id: "layout-test-user", username: "layout", displayName: "布局测试", role: "user", status: "active", mustChangePassword: false }, csrfToken: "layout-test-csrf", capabilities: {} };
    else if (path === "/api/content") body = { categories, items, version: "layout-test" };
    else if (path === "/api/me/mistakes") body = { items: [] };
    else if (path === "/api/me/summary") body = { totals: {} };
    else if (path === "/api/practice/sessions") body = { session: { id: `layout-session-${++sessions}`, startedAt: new Date().toISOString() } };
    else if (path.endsWith("/finish")) body = { ok: true };
    else if (path === "/api/auth/logout") { loggedOut = true; body = { ok: true }; }
    else if (path.includes("attempt")) { attempts += 1; body = {}; }
    else throw new Error(`Unexpected layout request ${path}`);
    return route.fulfill({ contentType: "application/json", body: JSON.stringify(body) });
  });
  await page.goto("/practice");
  await expect(page.locator("#answerInput")).toBeEnabled();
  await expect(page.locator("[data-layout-reset]")).toBeVisible();
  return { sessions: () => sessions, attempts: () => attempts };
}

async function width(page: Page, selector = ".practice-layout") {
  return page.locator(selector).evaluate(element => element.getBoundingClientRect().width);
}

async function expectWidth(page: Page, expected: number, selector = ".practice-layout") {
  await expect.poll(async () => Math.abs(await width(page, selector) - expected)).toBeLessThan(2);
}

async function drag(page: Page, handle: "left" | "right" | "split", delta: number, release = true) {
  const locator = page.locator(`[data-layout-handle="${handle}"]`);
  await expect(locator).toBeVisible();
  let box = await locator.boundingBox();
  if (!box) throw new Error(`Missing ${handle} handle`);
  const viewportHeight = page.viewportSize()!.height;
  if (box.y + box.height <= 0 || box.y >= viewportHeight) {
    await locator.scrollIntoViewIfNeeded();
    box = (await locator.boundingBox())!;
  }
  const visibleTop = Math.max(0, box.y);
  const visibleBottom = Math.min(viewportHeight, box.y + box.height);
  const start = { x: box.x + box.width / 2, y: (visibleTop + visibleBottom) / 2 };
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(start.x + delta, start.y, { steps: 6 });
  if (release) await page.mouse.up();
  return start;
}

test("formal account build resizes columns without restarting or submitting an essay", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const app = await mockPractice(page);
  expect(await page.locator('script[src^="/assets/"]').count()).toBeGreaterThan(0);
  await expectWidth(page, 1408);
  await expectWidth(page, 300, ".practice-side");
  await page.locator("#categorySelect").selectOption(essay.id);
  await expect(page.locator("#targetWord")).toHaveText(first.english);
  await page.locator(".cet4-preview summary").click();
  await page.locator("#answerInput").fill("keep this draft");
  const sessions = app.sessions();
  await drag(page, "right", -104);
  await expectWidth(page, 1200);
  await drag(page, "split", -60);
  await expectWidth(page, 360, ".practice-side");
  await expect(page.locator("#answerInput")).toHaveValue("keep this draft");
  await expect(page.locator("#targetWord")).toHaveText(first.english);
  await expect(page.locator(".cet4-preview")).toHaveAttribute("open", "");
  await expect(page.locator(".alignment-path").first()).toBeVisible();
  expect(app.sessions()).toBe(sessions);
  expect(app.attempts()).toBe(0);
  await page.screenshot({ path: "out/layout-account-wide.png", fullPage: true });

  await page.locator('[data-layout-handle="left"]').focus();
  await page.keyboard.press("ArrowRight");
  await expectWidth(page, 1184);
  await page.locator("[data-layout-reset]").click();
  await expectWidth(page, 1408);
  await expectWidth(page, 300, ".practice-side");
  await expect(page.locator("#answerInput")).toHaveValue("keep this draft");
  expect(app.sessions()).toBe(sessions);
  expect(app.attempts()).toBe(0);
});

test("account layout preference survives refresh and viewport shrink without overwriting", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await mockPractice(page);
  await drag(page, "right", -104);
  await drag(page, "split", -60);
  const saved = await page.evaluate(key => localStorage.getItem(key), storageKey);
  expect(JSON.parse(saved!)).toMatchObject({ version: 1, pageWidth: 1200, sideWidth: 360 });
  await page.reload();
  await expect(page.locator("#answerInput")).toBeEnabled();
  await expectWidth(page, 1200);
  await expectWidth(page, 360, ".practice-side");
  await page.setViewportSize({ width: 900, height: 800 });
  await expectWidth(page, 880);
  await expect(page.locator(".practice-layout")).toHaveClass(/layout-stacked/);
  await expect(page.locator('[data-layout-handle="right"]')).toBeHidden();
  expect(await page.evaluate(key => localStorage.getItem(key), storageKey)).toBe(saved);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await expectWidth(page, 1200);
  await expectWidth(page, 360, ".practice-side");
});

test("account settings wrap at a narrow chosen width in a wide browser", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.addInitScript(key => localStorage.setItem(key, JSON.stringify({ version: 1, pageWidth: 760, sideWidth: 300 })), storageKey);
  await mockPractice(page);
  await expectWidth(page, 760);
  await expect(page.locator(".practice-layout")).toHaveClass(/layout-stacked/);
  await expect(page.locator(".practice-layout")).toHaveClass(/layout-compact/);
  await expect(page.locator('[data-layout-handle="split"]')).toBeHidden();
  const shell = await page.locator(".practice-layout").boundingBox();
  for (const selector of ["#categorySelect", "#orderSelect", "#resetButton", "#speakButton", "#nextButton", "#voiceSelect"]) {
    const box = await page.locator(selector).boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(shell!.x);
    expect(box!.x + box!.width).toBeLessThanOrEqual(shell!.x + shell!.width + 1);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await page.screenshot({ path: "out/layout-account-narrow.png", fullPage: true });
});

test("account mobile preview and arrows fit a 375px viewport", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await mockPractice(page);
  await page.locator("#categorySelect").selectOption(essay.id);
  await page.locator(".cet4-preview summary").click();
  await expect(page.locator(".practice-layout")).toHaveClass(/layout-small/);
  for (const handle of ["left", "right", "split"]) await expect(page.locator(`[data-layout-handle="${handle}"]`)).toBeHidden();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await expect(page.locator(".alignment-path").first()).toBeVisible();
  const scroll = await page.locator("#alignmentScroll").evaluate(element => ({ client: element.clientWidth, scroll: element.scrollWidth }));
  expect(scroll.scroll).toBeGreaterThan(scroll.client);
  await page.screenshot({ path: "out/layout-account-mobile.png", fullPage: true });
});

test("leaving practice during a drag removes handles and releases layout state", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const app = await mockPractice(page);
  const start = await drag(page, "right", -80, false);
  // Keep the pointer down while navigating so route disposal must cancel the active drag.
  await page.locator("#logoutButton").evaluate(button => (button as HTMLButtonElement).click());
  await expect(page.locator("#passwordLoginForm")).toBeVisible();
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.locator(".practice-layout, [data-layout-handle], [data-layout-reset], .practice-layout-dragging")).toHaveCount(0);
  const savedAfterLogout = await page.evaluate(key => localStorage.getItem(key), storageKey);
  await page.mouse.move(start.x - 180, start.y);
  await page.mouse.up();
  await page.setViewportSize({ width: 1000, height: 800 });
  expect(await page.evaluate(key => localStorage.getItem(key), storageKey)).toBe(savedAfterLogout);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  expect(app.attempts()).toBe(0);
});

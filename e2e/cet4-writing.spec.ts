import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
const writing = require("../cet4-writing.js");
const source = JSON.parse(readFileSync("cet4-writing.json", "utf8"));
const parsed = writing.parse(source);
const essay = source.essays[0];
const first = essay.paragraphs[0][0];
const dataUrl = /\/cet4-writing(?:-[^/?]+)?\.json(?:\?.*)?$/;

async function mockPractice(page: Page, mutate?: (items: any[]) => void) {
  const categories = parsed.categories.map((category: any) => ({ ...category, id: category.slug }));
  const items = parsed.items.map((item: any) => ({ ...item, id: item.key, categoryId: item.categorySlug, revision: 1 }));
  mutate?.(items);
  let sessions = 0;
  await page.route("**/api/**", route => {
    const path = new URL(route.request().url()).pathname;
    let body: unknown;
    if (path === "/api/auth/session") body = { user: { id: "cet4-test-user", username: "writer", displayName: "写作测试", role: "user", status: "active", mustChangePassword: false }, csrfToken: "cet4-test-csrf", capabilities: {} };
    else if (path === "/api/content") body = { categories, items, version: "cet4-test" };
    else if (path === "/api/me/mistakes") body = { items: [] };
    else if (path === "/api/me/summary") body = { totals: {} };
    else if (path === "/api/practice/sessions") body = { session: { id: `cet4-session-${++sessions}`, startedAt: new Date().toISOString() } };
    else if (path.endsWith("/finish")) body = { ok: true };
    else throw new Error(`Unexpected CET-4 request ${path}`);
    return route.fulfill({ contentType: "application/json", body: JSON.stringify(body) });
  });
  await page.goto("/practice");
  await expect(page.locator("#answerInput")).toBeEnabled();
  return { sessions: () => sessions };
}

test("production preview and delayed resource preserve the answer and session", async ({ page }) => {
  let release!: () => void;
  const delay = new Promise<void>(resolve => { release = resolve; });
  await page.route(dataUrl, async route => { await delay; await route.continue(); });
  const app = await mockPractice(page);
  await page.locator("#categorySelect").selectOption(essay.id);
  await expect(page.locator("#targetWord")).toHaveText(first.english);
  await page.locator("#answerInput").fill("keep this answer");
  const sessions = app.sessions();
  release();
  await expect(page.locator(".cet4-preview summary")).toBeVisible();
  await expect(page.locator("#answerInput")).toHaveValue("keep this answer");
  await expect(page.locator("#answerInput")).toBeFocused();
  await page.locator(".cet4-preview summary").click();
  await expect(page.locator(".cet4-english .is-current")).toHaveText(first.english);
  await expect(page.locator("#answerInput")).toHaveValue("keep this answer");
  expect(app.sessions()).toBe(sessions);
  await page.locator("#showEnglish").uncheck();
  await expect(page.locator(".cet4-preview")).toBeHidden();
  await expect(page.locator("#answerInput")).toHaveValue("keep this answer");
  expect(await page.locator('script[src^="/assets/"]').count()).toBeGreaterThan(0);
});

for (const mutation of ["edit", "archive", "key", "category", "extra"]) {
  test(`administrator ${mutation} disables stale full essay without disabling practice`, async ({ page }) => {
    await mockPractice(page, items => {
      const index = items.findIndex(item => item.key === essay.paragraphs[0][1].key);
      if (mutation === "edit") items[index].meaning = "管理员修改后的翻译。";
      if (mutation === "archive") items.splice(index, 1);
      if (mutation === "key") items[index].key = "admin-renamed-key";
      if (mutation === "category") items[index].categoryId = source.essays[1].id;
      if (mutation === "extra") items.push({ ...items[index], id: "extra-item", key: "extra-item", english: "An extra sentence." });
    });
    await page.locator("#categorySelect").selectOption(essay.id);
    await expect(page.locator(".cet4-unavailable")).toBeVisible();
    await expect(page.locator(".cet4-preview")).toHaveCount(0);
    await expect(page.locator("#targetWord")).toHaveText(first.english);
    await expect(page.locator("#answerInput")).toBeEnabled();
  });
}

test("account preview fits a 375px viewport", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await mockPractice(page);
  await page.locator("#categorySelect").selectOption(essay.id);
  await page.locator(".cet4-preview summary").click();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await expect(page.locator(".alignment-path").first()).toBeVisible();
  await page.screenshot({ path: "out/cet4-account-mobile.png", fullPage: true });
});

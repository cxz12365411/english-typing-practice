import { expect, test, type Page, type Route } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";

const user = {
  id: "promo-user", username: "promo.learner", displayName: "演示验收", role: "user",
  status: "active", mustChangePassword: false, createdAt: "2026-10-27T00:00:00.000Z"
};
const category = { id: "words", name: "基础单词", kind: "word", sortOrder: 0, status: "published" };
const item = {
  id: "promo-word", key: "promo-word-key", english: "memory", meaning: "记忆", pronunciation: "梅默伊",
  categoryId: "words", kind: "word", revision: 1, sortOrder: 0, status: "published"
};

async function json(route: Route, body: unknown) {
  await route.fulfill({ contentType: "application/json", body: JSON.stringify(body) });
}

async function mockLogin(page: Page, emailEnabled = false) {
  const capabilities = { emailAuthEnabled: emailEnabled, selfRegistrationEnabled: emailEnabled };
  let currentUser: typeof user | null = null;
  const requests: Array<{ path: string; body: unknown }> = [];
  await page.route("**/api/**", async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const body = request.postDataJSON();
    if (request.method() === "POST") requests.push({ path, body });
    if (path === "/api/auth/session") return json(route, { user: currentUser, csrfToken: "promo-csrf", capabilities });
    if (path === "/api/auth/login") {
      currentUser = user;
      return json(route, { user, csrfToken: "promo-login-csrf", capabilities });
    }
    if (path === "/api/auth/logout") {
      currentUser = null;
      return route.fulfill({ status: 204 });
    }
    if (path === "/api/content") return json(route, { categories: [category], items: [item], version: 1 });
    if (path === "/api/me/mistakes") return json(route, { items: [] });
    if (path === "/api/me/summary") return json(route, { totals: { sessions: 0, attempts: 0, correct: 0, accuracy: 0 } });
    if (path === "/api/practice/sessions") return json(route, { session: { id: "promo-session", startedAt: new Date().toISOString() } });
    if (path.endsWith("/finish")) return json(route, { ok: true });
    throw new Error(`Unexpected promo request: ${request.method()} ${path}`);
  });
  return requests;
}

async function freezeClock(page: Page) {
  await page.clock.install({ time: new Date("2026-10-27T00:00:00Z") });
  await page.clock.pauseAt(new Date("2026-10-27T00:00:01Z"));
}

async function captureLayout(page: Page, width: number) {
  const geometry = await page.evaluate(() => {
    const rect = (selector: string) => {
      const bounds = document.querySelector(selector)!.getBoundingClientRect();
      return { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height, right: bounds.right };
    };
    return {
      viewport: innerWidth, scrollWidth: document.documentElement.scrollWidth,
      home: rect(".login-home"), story: rect(".login-story"), promo: rect("#loginPromo"),
      login: rect(".auth-card"), submit: rect('#passwordLoginForm button[type="submit"]')
    };
  });
  expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.viewport);
  expect(geometry.submit.height).toBeGreaterThanOrEqual(44);
  if (width >= 940) expect(geometry.promo.width).toBeGreaterThan(geometry.login.width);
  mkdirSync("out", { recursive: true });
  writeFileSync(`out/login-promo-large-${width}-geometry.json`, JSON.stringify(geometry, null, 2));
  await page.screenshot({ path: `out/login-promo-large-${width}.png`, fullPage: true, animations: "disabled" });
}

test("login demo presents both learning aids and keeps playing through three eight-second cycles", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await freezeClock(page);
  await mockLogin(page);
  await page.goto("/login");
  const promo = page.locator("#loginPromo");
  await expect(promo).toHaveAttribute("data-promo-status", "playing");
  await expect(promo).toHaveAttribute("data-promo-duration", "8000");
  await expect(promo.locator(".promo-topline, .promo-bottomline, button")).toHaveCount(0);
  await expect(promo).not.toContainText("ENGLISH, CONNECTED.");
  await expect(promo).not.toContainText("8 秒 · 产品演示");
  await expect(promo.getByRole("button", { name: "暂停演示", exact: true })).toHaveAttribute("tabindex", "0");
  await page.clock.runFor(2000);
  await expect(promo).toHaveAttribute("data-promo-stage", "arrows");
  await expect(promo).toContainText("Would");
  await expect(promo).toContainText("愿意");
  await expect(promo.locator("[data-promo-group].is-active").first()).toBeAttached();
  await captureLayout(page, 1440);
  await page.clock.runFor(3200);
  await expect(promo).toHaveAttribute("data-promo-stage", "mnemonic");
  await expect(promo).toContainText("memory");
  await expect(promo).toContainText("梅默伊");
  await page.screenshot({ path: "out/login-promo-loop-account-desktop-mnemonic.png", fullPage: true, animations: "disabled" });
  await page.clock.runFor(3000);
  await expect(promo).toHaveAttribute("data-promo-stage", "hook");
  await expect(promo).toHaveAttribute("data-promo-status", "playing");
  expect(Number(await promo.getAttribute("data-promo-elapsed"))).toBeLessThan(500);
  await page.clock.runFor(1800);
  await expect(promo).toHaveAttribute("data-promo-stage", "arrows");
  await page.clock.runFor(3200);
  await expect(promo).toHaveAttribute("data-promo-stage", "mnemonic");
  await page.clock.runFor(3000);
  await expect(promo).toHaveAttribute("data-promo-stage", "hook");
  await expect(promo).toHaveAttribute("data-promo-status", "playing");
});

test("pause across multiple cycles and keyboard resume leave typed credentials untouched", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await freezeClock(page);
  const requests = await mockLogin(page);
  await page.goto("/login");
  const promo = page.locator("#loginPromo");
  const card = promo.locator(".practice-promo");
  const username = page.locator('#passwordLoginForm [name="username"]');
  const password = page.locator('#passwordLoginForm [name="password"]');
  await expect(promo).toHaveAttribute("data-promo-status", "playing");
  await username.fill("draft.learner");
  await password.fill("LocalOnlyDraft!2026");
  await page.clock.runFor(1800);
  await expect(password).toBeFocused();
  await card.click();
  await expect(promo).toHaveAttribute("data-promo-status", "paused");
  await expect(card).toHaveAttribute("aria-label", "继续演示");
  const elapsed = await promo.getAttribute("data-promo-elapsed");
  await page.clock.runFor(17000);
  await expect(promo).toHaveAttribute("data-promo-elapsed", elapsed!);
  const scrollY = await page.evaluate(() => window.scrollY);
  await card.press("Space");
  await expect(promo).toHaveAttribute("data-promo-status", "playing");
  expect(await page.evaluate(() => window.scrollY)).toBe(scrollY);
  await page.clock.runFor(500);
  expect(Number(await promo.getAttribute("data-promo-elapsed"))).toBeGreaterThan(Number(elapsed));
  await page.clock.runFor(6000);
  await expect(promo).toHaveAttribute("data-promo-status", "playing");
  await expect(card).toHaveAttribute("aria-label", "暂停演示");
  await expect(promo).toHaveAttribute("data-promo-stage", "hook");
  await expect(username).toHaveValue("draft.learner");
  await expect(password).toHaveValue("LocalOnlyDraft!2026");
  expect(requests).toEqual([]);
});

test("successful login disposes the old demo and logout creates a fresh instance", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await freezeClock(page);
  const requests = await mockLogin(page);
  await page.goto("/login");
  const promo = page.locator("#loginPromo");
  await expect(promo).toHaveAttribute("data-promo-status", "playing");
  await page.clock.runFor(1500);
  const oldHost = await promo.elementHandle();
  await page.locator('#passwordLoginForm [name="username"]').fill("promo.learner");
  await page.locator('#passwordLoginForm [name="password"]').fill("LocalOnlyLogin!2026");
  await page.locator("#passwordLoginForm").getByRole("button", { name: "登录", exact: true }).click();
  await expect(page).toHaveURL(/\/practice$/);
  await expect(page.locator("#answerInput")).toBeEnabled();
  await expect(promo).toHaveCount(0);
  const stoppedAt = await oldHost!.evaluate(el => (el as HTMLElement).dataset.promoElapsed);
  await page.clock.runFor(10000);
  expect(await oldHost!.evaluate(el => (el as HTMLElement).dataset.promoElapsed)).toBe(stoppedAt);
  expect(requests.filter(request => request.path === "/api/auth/login")).toEqual([
    { path: "/api/auth/login", body: { username: "promo.learner", password: "LocalOnlyLogin!2026" } }
  ]);
  await page.locator("#logoutButton").click();
  await expect(page).toHaveURL(/\/login$/);
  await expect(promo).toHaveCount(1);
  await expect(promo).toHaveAttribute("data-promo-stage", "hook");
});

test("375px login remains usable with a static reduced-motion poster and optional playback", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 900 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await freezeClock(page);
  await mockLogin(page);
  await page.goto("/login");
  const promo = page.locator("#loginPromo");
  await expect(promo).toHaveAttribute("data-promo-stage", "finish");
  await expect(promo).toHaveAttribute("data-promo-status", "finished");
  await page.clock.runFor(9000);
  await expect(promo).toHaveAttribute("data-promo-elapsed", "8000");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await expect(page.locator('#passwordLoginForm [name="username"]')).toBeVisible();
  await expect(page.locator('#passwordLoginForm [name="password"]')).toBeVisible();
  await promo.getByRole("button", { name: "重播演示", exact: true }).click();
  await page.clock.runFor(5200);
  await expect(promo).toHaveAttribute("data-promo-stage", "mnemonic");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const clipped = await promo.evaluate(host => {
    const bounds = host.getBoundingClientRect();
    return [...host.querySelectorAll<HTMLElement>(".practice-promo, .promo-view, .promo-mnemonic, .promo-memory-word, .promo-memory-clue")]
      .map(element => {
        const rect = element.getBoundingClientRect();
        return { element: element.className, left: rect.left, right: rect.right, width: rect.width, scrollLeft: element.scrollLeft };
      }).filter(rect => rect.left < bounds.left - 1 || rect.right > bounds.right + 1);
  });
  expect(clipped, "the mnemonic must remain inside the visible card, not be clipped by overflow:hidden").toEqual([]);
  await captureLayout(page, 375);
  await page.clock.runFor(3100);
  await expect(promo).toHaveAttribute("data-promo-stage", "hook");
  await expect(promo).toHaveAttribute("data-promo-status", "playing");
});

test("email-enabled auth tabs remain keyboard accessible beside the demo", async ({ page }) => {
  await page.setViewportSize({ width: 1031, height: 1000 });
  await freezeClock(page);
  await mockLogin(page, true);
  await page.goto("/login");
  await page.getByRole("tab", { name: "账号密码", exact: true }).click();
  await expect(page.locator('#passwordLoginForm [name="username"]')).toBeFocused();
  expect(await page.locator(".auth-tabs").evaluate(tabs => {
    const bounds = tabs.getBoundingClientRect();
    return tabs.scrollWidth <= tabs.clientWidth && [...tabs.querySelectorAll('[role="tab"]')].every(tab => {
      const rect = tab.getBoundingClientRect();
      return rect.left >= bounds.left && rect.right <= bounds.right;
    });
  }), "all four auth tabs must fit the compact login card without horizontal clipping").toBe(true);
  await page.clock.runFor(2000);
  await captureLayout(page, 1031);
  await page.locator('#passwordLoginForm [name="username"]').fill("tab.draft");
  await page.locator('#passwordLoginForm [name="password"]').fill("UnsubmittedDraft!2026");
  await page.getByRole("tab", { name: "账号密码", exact: true }).focus();
  await page.keyboard.press("ArrowLeft");
  await expect(page.getByRole("tab", { name: "找回密码", exact: true })).toHaveAttribute("aria-selected", "true");
  await page.getByRole("tab", { name: "账号密码", exact: true }).click();
  await expect(page.locator('#passwordLoginForm [name="username"]')).toHaveValue("tab.draft");
  await expect(page.locator('#passwordLoginForm [name="password"]')).toHaveValue("UnsubmittedDraft!2026");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

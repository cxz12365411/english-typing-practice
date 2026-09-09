import { expect, test, type Page, type Route } from "@playwright/test";

const admin = {
  id: "admin-original", username: "admin.original", displayName: "原管理员", role: "admin",
  status: "active", mustChangePassword: false, createdAt: "2026-09-10T00:00:00.000Z"
};
const nextAdmin = { ...admin, id: "admin-next", username: "admin.next", displayName: "新管理员" };
const learner = { ...admin, id: "learner", username: "learner", displayName: "测试学员", role: "user" };
const category = { id: "words", slug: "words", name: "测试单词", kind: "word", sortOrder: 0, status: "published" };
const item = {
  id: "item-1", key: "apple", english: "apple", meaning: "苹果", pronunciation: "",
  categoryId: category.id, kind: "word", revision: 1, sortOrder: 0, status: "published"
};
const csv = "categoryId,english,meaning,status\nwords,pear,梨,published";
const preview = { importId: "preview-1", rows: [{ categoryId: "words", english: "pear", meaning: "梨", status: "published" }], errors: [], summary: { total: 1 } };

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function json(route: Route, body: unknown, status = 200): Promise<void> {
  await route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
}

async function mockAdmin(page: Page): Promise<void> {
  let currentUser: typeof admin | null = admin;
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const session = () => ({ user: currentUser, csrfToken: "test-csrf", capabilities: { emailAuthEnabled: false, selfRegistrationEnabled: false } });
    if (path === "/api/auth/session") return json(route, session());
    if (path === "/api/auth/logout") {
      currentUser = null;
      return route.fulfill({ status: 204 });
    }
    if (path === "/api/auth/login") {
      currentUser = nextAdmin;
      return json(route, session());
    }
    if (path === "/api/admin/users") {
      if (request.method() === "POST") return json(route, { user: learner, temporaryPassword: "Temporary-Secret-123" });
      return json(route, { users: [currentUser, learner] });
    }
    if (path === "/api/admin/categories") return json(route, { categories: [category] });
    if (path === "/api/admin/items") return json(route, { items: [item] });
    if (path === "/api/admin/stats") return json(route, { stats: { users: { total: 2 } } });
    if (path === "/api/admin/audit") return json(route, { entries: [] });
    if (path === "/api/admin/imports/preview") return json(route, preview);
    if (path === "/api/admin/imports/commit") return json(route, { imported: 1 });
    if (path === "/api/content") return json(route, { categories: [category], items: [item], version: 1 });
    if (path === "/api/me/mistakes") return json(route, { items: [] });
    if (path === "/api/me/summary") return json(route, { totals: { sessions: 0, attempts: 0, correct: 0, accuracy: 0 } });
    if (path === "/api/practice/sessions") return json(route, { session: { id: "session-test", startedAt: new Date().toISOString() } });
    if (path.endsWith("/finish")) return json(route, { ok: true });
    throw new Error(`Unexpected mocked request: ${request.method()} ${path}`);
  });
}

async function openAdmin(page: Page, tab = "users"): Promise<void> {
  await page.goto("/admin");
  await page.locator(`[data-admin-tab="${tab}"]`).click();
}

async function returnToAdmin(page: Page, tab = "users"): Promise<void> {
  await page.getByRole("link", { name: "练习", exact: true }).click();
  await expect(page.locator("#answerInput")).toBeEnabled();
  await page.getByRole("link", { name: "管理后台", exact: true }).click();
  await page.locator(`[data-admin-tab="${tab}"]`).click();
}

async function releaseResponse(page: Page, pending: ReturnType<typeof deferred>, path: string): Promise<void> {
  const response = page.waitForResponse((value) => new URL(value.url()).pathname === path);
  pending.resolve();
  await (await response).finished();
  await page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
}

for (const action of ["create", "reset"] as const) {
  test(`late ${action} password response cannot appear in another administrator's page`, async ({ page }) => {
    await mockAdmin(page);
    const pending = deferred();
    let requested = false;
    const path = action === "create" ? "/api/admin/users" : "/api/admin/users/learner/reset-password";
    await page.route(`**${path}`, async (route) => {
      if (route.request().method() !== "POST") return route.fallback();
      requested = true;
      await pending.promise;
      await json(route, { user: learner, temporaryPassword: "Other-Admin-Secret-123" });
    });
    await openAdmin(page);
    if (action === "create") {
      await page.locator('#createUserForm [name="username"]').fill("created.user");
      await page.locator('#createUserForm [name="displayName"]').fill("新学员");
      await page.locator('#createUserForm button[type="submit"]').click();
    } else {
      page.once("dialog", (dialog) => dialog.accept());
      await page.locator('[data-user-action="reset"][data-id="learner"]').click();
    }
    await expect.poll(() => requested).toBeTruthy();
    await page.locator("#logoutButton").click();
    await page.locator('#passwordLoginForm [name="username"]').fill(nextAdmin.username);
    await page.locator('#passwordLoginForm [name="password"]').fill("new-admin-password");
    await page.locator('#passwordLoginForm button[type="submit"]').click();
    await page.locator('[data-admin-tab="users"]').click();
    await expect(page.locator(".user-chip strong")).toHaveText(nextAdmin.displayName);
    await releaseResponse(page, pending, path);
    await expect(page.locator("#temporaryPasswordBox")).toHaveCount(0);
    await expect(page.locator("body")).not.toContainText("Other-Admin-Secret-123");
    await expect(page.locator("#toastRegion")).toBeEmpty();
  });
}

test("a late user reload cannot replace data or a form on a reopened admin page", async ({ page }) => {
  await mockAdmin(page);
  const pending = deferred();
  let loads = 0;
  await page.route("**/api/admin/users", async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    if (++loads !== 2) return route.fallback();
    await pending.promise;
    await json(route, { users: [{ ...learner, id: "obsolete", username: "obsolete.user" }] });
  });
  await openAdmin(page);
  await page.locator('#createUserForm [name="username"]').fill("created.user");
  await page.locator('#createUserForm [name="displayName"]').fill("新学员");
  await page.locator('#createUserForm button[type="submit"]').click();
  await expect.poll(() => loads).toBe(2);
  await returnToAdmin(page);
  await page.locator('#createUserForm [name="username"]').fill("unsaved.user");
  await releaseResponse(page, pending, "/api/admin/users");
  await expect(page.locator('#createUserForm [name="username"]')).toHaveValue("unsaved.user");
  await expect(page.locator('[data-user-row="obsolete"]')).toHaveCount(0);
  await expect(page.locator("#temporaryPasswordBox")).toHaveCount(0);
});

test("a late content reload cannot overwrite a reopened content editor", async ({ page }) => {
  await mockAdmin(page);
  const pending = deferred();
  let loads = 0;
  await page.route("**/api/admin/items", async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    if (++loads !== 2) return route.fallback();
    await pending.promise;
    await json(route, { items: [{ ...item, english: "obsolete-content" }] });
  });
  await page.route("**/api/admin/items/item-1/archive", (route) => json(route, { item: { ...item, status: "archived" } }));
  await openAdmin(page, "content");
  page.once("dialog", (dialog) => dialog.accept());
  await page.locator('[data-item-action="archive"]').click();
  await expect.poll(() => loads).toBe(2);
  await returnToAdmin(page, "content");
  await page.locator('#itemForm [name="english"]').fill("unsaved-content");
  await releaseResponse(page, pending, "/api/admin/items");
  await expect(page.locator('#itemForm [name="english"]')).toHaveValue("unsaved-content");
  await expect(page.locator("body")).not.toContainText("obsolete-content");
});

for (const staleFailure of [false, true]) {
  test(`older refresh ${staleFailure ? "errors" : "results"} cannot overwrite the latest refresh`, async ({ page }) => {
    await mockAdmin(page);
    const pending = deferred();
    let loads = 0;
    await page.route("**/api/admin/users", async (route) => {
      if (++loads === 1) return route.fallback();
      if (loads === 2) {
        await pending.promise;
        if (staleFailure) return json(route, { error: { code: "AUTH_REQUIRED" } }, 401);
        return json(route, { users: [{ ...learner, id: "older", username: "older.user" }] });
      }
      await json(route, { users: [{ ...learner, id: "latest", username: "latest.user" }] });
    });
    await openAdmin(page);
    await page.locator("#refreshAdminButton").click();
    await expect.poll(() => loads).toBe(2);
    await page.locator("#refreshAdminButton").click();
    await expect(page.locator('[data-user-row="latest"]')).toBeVisible();
    await releaseResponse(page, pending, "/api/admin/users");
    await expect(page).toHaveURL(/\/admin$/);
    await expect(page.locator('[data-user-row="latest"]')).toBeVisible();
    await expect(page.locator('[data-user-row="older"]')).toHaveCount(0);
  });
}

test("finishing a refresh after switching tabs preserves the new editor input", async ({ page }) => {
  await mockAdmin(page);
  const pending = deferred();
  let loads = 0;
  await page.route("**/api/admin/stats", async (route) => {
    if (++loads === 1) return route.fallback();
    await pending.promise;
    await json(route, { stats: {} });
  });
  await openAdmin(page);
  await page.locator("#refreshAdminButton").click();
  await expect.poll(() => loads).toBe(2);
  await page.locator('[data-admin-tab="content"]').click();
  await page.locator('#itemForm [name="english"]').fill("keep-this-edit");
  await releaseResponse(page, pending, "/api/admin/stats");
  await expect(page.locator('#itemForm [name="english"]')).toHaveValue("keep-this-edit");
});

test("CSV preview preserves the source, invalidates edited rows, and reports published imports accurately", async ({ page }) => {
  await mockAdmin(page);
  await openAdmin(page, "import");
  await page.locator("#csvText").fill(csv);
  await page.locator('#csvPreviewForm button[type="submit"]').click();
  await expect(page.locator("#commitImportButton")).toBeEnabled();
  await expect(page.locator("#csvText")).toHaveValue(csv);
  await page.locator("#csvText").fill(csv.replace("pear", "peach"));
  await expect(page.locator("#commitImportButton")).toHaveCount(0);
  await expect(page.locator("#importPreviewContent")).toContainText("请重新校验");
  await page.locator("#csvText").fill(csv);
  await page.locator('#csvPreviewForm button[type="submit"]').click();
  page.once("dialog", (dialog) => dialog.accept());
  await page.locator("#commitImportButton").click();
  await expect(page.locator("#toastRegion")).toContainText("内容状态以预览为准");
  await expect(page.locator("#toastRegion")).not.toContainText("草稿");
});

test("editing CSV while validation is pending discards the outdated preview", async ({ page }) => {
  await mockAdmin(page);
  const pending = deferred();
  let requested = false;
  await page.route("**/api/admin/imports/preview", async (route) => {
    requested = true;
    await pending.promise;
    await json(route, preview);
  });
  await openAdmin(page, "import");
  await page.locator("#csvText").fill(csv);
  await page.locator('#csvPreviewForm button[type="submit"]').click();
  await expect.poll(() => requested).toBeTruthy();
  const editedCsv = csv.replace("pear", "peach");
  await page.locator("#csvText").fill(editedCsv);
  await releaseResponse(page, pending, "/api/admin/imports/preview");
  await expect(page.locator("#csvText")).toHaveValue(editedCsv);
  await expect(page.locator("#commitImportButton")).toHaveCount(0);
  await expect(page.locator('#csvPreviewForm button[type="submit"]')).toBeEnabled();
});

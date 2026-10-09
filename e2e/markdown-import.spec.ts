import { expect, test, type Page, type Route } from "@playwright/test";
import type { MarkdownImportPreview } from "../web/src/types";

const admin = { id: "markdown-admin", username: "markdown.admin", displayName: "导入管理员", role: "admin", status: "active", mustChangePassword: false, createdAt: "2026-10-09T00:00:00.000Z" };
const category = { id: "markdown-category", slug: "markdown-category", name: "句型：街头摄影", kind: "sentence", sortOrder: 1, status: "published" };
const item = { id: "markdown-item", key: "markdown-1", categoryId: category.id, kind: "sentence", english: "May I take your photo?", meaning: "我可以给你拍张照吗？", pronunciation: "梅 爱 泰克 尤尔 佛托？", revision: 1, sortOrder: 0, status: "published" };
const markdown = "## 句型：街头摄影\n| 英文 | 中文释义 | 中文谐音 |\n| --- | --- | --- |\n| May I take your photo? | 我可以给你拍张照吗？ | 梅 爱 泰克 尤尔 佛托？ |";

function preview(overrides: Partial<MarkdownImportPreview> = {}): MarkdownImportPreview {
  return {
    previewId: "markdown-preview",
    groups: [{ groupId: "section-1", row: 1, title: "句型：街头摄影", name: "街头摄影", kind: "sentence", action: "existing", categoryId: category.id }],
    rows: [{ row: 4, groupId: "section-1", categoryName: category.name, categoryId: category.id, kind: "sentence", english: item.english, meaning: item.meaning, pronunciation: item.pronunciation, action: "create" }],
    errors: [], warnings: [],
    summary: { total: 1, created: 1, reused: 0, unavailable: 0, duplicates: 0, practiceCount: 1, ignoredCount: 0 },
    expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
    ...overrides
  };
}

async function json(route: Route, body: unknown, status = 200): Promise<void> {
  await route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
}

async function mockAdmin(page: Page): Promise<void> {
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/auth/session") return json(route, { user: admin, csrfToken: "md-csrf", capabilities: { emailAuthEnabled: false, selfRegistrationEnabled: false } });
    if (path === "/api/admin/users") return json(route, { users: [admin] });
    if (path === "/api/admin/categories") return json(route, { categories: [category] });
    if (path === "/api/admin/items") return json(route, { items: [item] });
    if (path === "/api/admin/stats") return json(route, { stats: {} });
    if (path === "/api/admin/audit") return json(route, { entries: [] });
    if (path === "/api/admin/markdown-imports/preview") return json(route, preview());
    if (path === "/api/admin/markdown-imports/commit") return json(route, { ok: true, batchId: "markdown-batch", created: 1, reused: 0, skipped: 0, practiceCount: 1 });
    if (path === "/api/practice/import-batches/markdown-batch") return json(route, { batch: { id: "markdown-batch", fileName: "街拍.md", createdAt: new Date().toISOString() }, version: 1, categories: [category], items: [item], unavailableCount: 0 });
    if (path === "/api/content") return json(route, { version: 1, categories: [category], items: [item] });
    if (path === "/api/me/mistakes") return json(route, { items: [] });
    if (path === "/api/me/summary") return json(route, { totals: { sessions: 0, attempts: 0, correct: 0, accuracy: 0 } });
    if (path === "/api/practice/sessions") return json(route, { session: { id: "markdown-session", startedAt: new Date().toISOString() } });
    if (path.endsWith("/finish")) return json(route, { ok: true });
    throw new Error(`Unexpected Markdown mock: ${route.request().method()} ${path}`);
  });
  await page.goto("/admin");
}

async function openImport(page: Page): Promise<void> {
  await mockAdmin(page);
  await page.getByRole("button", { name: "批量导入", exact: true }).click();
}

async function upload(page: Page): Promise<void> {
  await page.locator("#markdownFileInput").setInputFiles({ name: "街拍.md", mimeType: "text/markdown", buffer: Buffer.from(`\uFEFF${markdown.replace(/\n/g, "\r\n")}`) });
  await expect(page.locator("#commitMarkdownImportButton")).toBeEnabled();
}

test("Markdown is the default bulk import and the content shortcut preserves CSV mode", async ({ page }) => {
  await openImport(page);
  await expect(page.locator("#markdownPreviewForm")).toBeVisible();
  await page.getByRole("button", { name: "CSV", exact: true }).click();
  await expect(page.locator("#csvPreviewForm")).toBeVisible();
  await page.locator("#csvText").fill("saved csv draft");
  await page.getByRole("button", { name: "题库管理", exact: true }).click();
  await page.getByRole("button", { name: "从 MD 导入", exact: true }).click();
  await expect(page.locator("#markdownPreviewForm")).toBeVisible();
  await page.getByRole("button", { name: "CSV", exact: true }).click();
  await expect(page.locator("#csvText")).toHaveValue("saved csv draft");
});

test("UTF-8 BOM upload previews automatically and publishing opens only that batch", async ({ page }) => {
  await openImport(page);
  let input: Record<string, unknown> | undefined;
  await page.route("**/api/admin/markdown-imports/preview", async (route) => { input = route.request().postDataJSON(); await json(route, preview()); });
  await upload(page);
  expect(input?.fileName).toBe("街拍.md");
  expect(String(input?.markdown).startsWith("## ")).toBeTruthy();
  await expect(page.locator("#markdownPreviewContent")).toContainText(item.english);
  await expect(page.locator("#markdownPreviewContent")).toContainText(item.pronunciation);
  await page.getByRole("button", { name: "导入并发布，开始练习", exact: true }).click();
  await expect(page).toHaveURL(/\/practice\?batch=markdown-batch$/);
  await expect(page.locator("#importBatchBanner")).toContainText("街拍.md");
  await expect(page.locator("#categorySelect")).toBeDisabled();
});

test("pasting previews automatically and editing invalidates the approved preview immediately", async ({ page }) => {
  await openImport(page);
  await page.locator("#markdownText").fill(markdown);
  await page.locator("#markdownText").dispatchEvent("paste");
  await expect(page.locator("#commitMarkdownImportButton")).toBeEnabled();
  await page.locator("#markdownText").fill(markdown + "\n说明：已编辑");
  await expect(page.locator("#commitMarkdownImportButton")).toHaveCount(0);
  await expect(page.locator("#markdownPreviewContent")).toContainText("重新校验");
  await page.locator("#previewMarkdownButton").click();
  await expect(page.locator("#commitMarkdownImportButton")).toBeEnabled();
  await page.locator("#markdownDefaultCategory").fill("改后的分类");
  await expect(page.locator("#commitMarkdownImportButton")).toHaveCount(0);
});

test("ambiguous mappings require selection and a new preview before publishing", async ({ page }) => {
  await openImport(page);
  const original = preview();
  let requests = 0;
  let mapping: unknown;
  await page.route("**/api/admin/markdown-imports/preview", async (route) => {
    ++requests;
    if (requests === 1) return json(route, preview({ groups: [{ ...original.groups[0], action: "ambiguous", categoryId: null }], errors: [{ row: 1, field: "category", message: "分类有多个匹配，请手选" }] }));
    mapping = route.request().postDataJSON().mappings;
    return json(route, original);
  });
  await page.locator("#markdownFileInput").setInputFiles({ name: "街拍.md", mimeType: "text/markdown", buffer: Buffer.from(markdown) });
  await expect(page.locator("#commitMarkdownImportButton")).toBeDisabled();
  await page.locator('[data-md-field="categoryId"]').selectOption(category.id);
  await expect(page.locator("#commitMarkdownImportButton")).toHaveCount(0);
  await page.locator("#previewMarkdownButton").click();
  await expect(page.locator("#commitMarkdownImportButton")).toBeEnabled();
  expect(mapping).toEqual([{ groupId: "section-1", categoryId: category.id }]);
});

test("a late preview cannot validate text edited while the request was pending", async ({ page }) => {
  await openImport(page);
  let resolve!: () => void;
  const wait = new Promise<void>((done) => { resolve = done; });
  let requested = false;
  await page.route("**/api/admin/markdown-imports/preview", async (route) => { requested = true; await wait; await json(route, preview()); });
  await page.locator("#markdownText").fill(markdown);
  await page.locator("#previewMarkdownButton").click();
  await expect.poll(() => requested).toBeTruthy();
  await page.locator("#markdownText").fill("## entirely changed");
  const response = page.waitForResponse("**/api/admin/markdown-imports/preview");
  resolve();
  await (await response).finished();
  await expect(page.locator("#previewMarkdownButton")).toBeEnabled();
  await expect(page.locator("#commitMarkdownImportButton")).toHaveCount(0);
  await expect(page.locator("#markdownText")).toHaveValue("## entirely changed");
});

test("a lost commit response retries the same preview and ignores double clicks", async ({ page }) => {
  await openImport(page);
  let previews = 0;
  const commits: string[] = [];
  await page.route("**/api/admin/markdown-imports/preview", async (route) => { ++previews; await json(route, preview()); });
  await page.route("**/api/admin/markdown-imports/commit", async (route) => {
    commits.push(route.request().postDataJSON().previewId);
    if (commits.length === 1) return route.abort("failed");
    await json(route, { ok: true, batchId: "markdown-batch", created: 1, reused: 0, skipped: 0, practiceCount: 1 });
  });
  await upload(page);
  await page.locator("#commitMarkdownImportButton").evaluate((button: HTMLButtonElement) => { button.click(); button.click(); });
  await expect(page.locator("#toastRegion")).toContainText("不会重复导入");
  await expect(page.locator("#commitMarkdownImportButton")).toBeEnabled();
  expect(commits).toEqual(["markdown-preview"]);
  await page.locator("#commitMarkdownImportButton").click();
  await expect(page).toHaveURL(/batch=markdown-batch$/);
  expect(commits).toEqual(["markdown-preview", "markdown-preview"]);
  expect(previews).toBe(1);
});

test("invalid UTF-8 and oversized files never reach the preview API", async ({ page }) => {
  await openImport(page);
  let previews = 0;
  await page.route("**/api/admin/markdown-imports/preview", async (route) => { ++previews; await json(route, preview()); });
  await page.locator("#markdownFileInput").setInputFiles({ name: "invalid.md", mimeType: "text/markdown", buffer: Buffer.from([0xc3, 0x28]) });
  await expect(page.locator("#markdownPreviewContent")).toContainText("不是有效的 UTF-8");
  await page.locator("#markdownFileInput").setInputFiles({ name: "huge.md", mimeType: "text/markdown", buffer: Buffer.alloc(1024 * 1024 + 1, 65) });
  await expect(page.locator("#markdownPreviewContent")).toContainText("不能超过 1 MiB");
  expect(previews).toBe(0);
});

test("mobile preview paginates all rows and renders file HTML as text", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openImport(page);
  const first = preview();
  const rows = Array.from({ length: 103 }, (_, index) => ({ ...first.rows[0], row: index + 4, english: index === 0 ? '<img src=x onerror="window.mdXss=1">' : `Phrase ${index + 1}` }));
  await page.route("**/api/admin/markdown-imports/preview", (route) => json(route, preview({ rows, summary: { ...first.summary, total: 103, created: 103, practiceCount: 103, ignoredCount: 2 } })));
  await upload(page);
  await expect(page.locator(".markdown-preview-table tbody tr")).toHaveCount(100);
  await expect(page.locator("#markdownPreviewContent")).toContainText("1–100 / 103");
  await expect(page.locator("#markdownPreviewContent img")).toHaveCount(0);
  await expect(page.locator("#markdownPreviewContent")).toContainText('<img src=x onerror="window.mdXss=1">');
  await page.getByRole("button", { name: "下一页", exact: true }).click();
  await expect(page.locator(".markdown-preview-table tbody tr")).toHaveCount(3);
  await expect(page.locator("#markdownPreviewContent")).toContainText("Phrase 103");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy();
});

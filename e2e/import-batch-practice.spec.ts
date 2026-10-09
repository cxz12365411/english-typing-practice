import { expect, test, type Page, type Route } from "@playwright/test";
import type { ContentCategory, ContentItem, ImportBatchContentResponse } from "../web/src/types";

const batchA = "batch-A";
const batchB = "batch-B";
const user = {
  id: "batch-owner", username: "batch.admin", displayName: "批次练习管理员", role: "admin",
  status: "active", mustChangePassword: false, createdAt: "2026-10-09T00:00:00.000Z"
};
const categories: ContentCategory[] = [
  { id: "word-category", name: "单词：日常单词", kind: "word", sortOrder: 1, status: "published" },
  { id: "sentence-category", name: "句型：日常交流", kind: "sentence", sortOrder: 2, status: "published" }
];
function item(id: string, english: string, categoryIndex: number, sortOrder: number): ContentItem {
  const category = categories[categoryIndex]!;
  return { id, key: id, english, meaning: `${id} 的中文释义`, pronunciation: "中文谐音示例", categoryId: category.id, kind: category.kind, sortOrder, revision: 1, status: "published" };
}
// The file intentionally starts with a late-sorted sentence, then a word, then
// an earlier sentence. Global category/item sorting must not reorder this list.
const fileItems = [
  item("file-late-sentence", "Could I take a photo of you?", 1, 99),
  item("file-word", "zebra", 0, 20),
  item("file-early-sentence", "Thank you for your time.", 1, 1)
];
const outside = item("outside-item", "apple", 0, 1);
const secondFileItem = item("second-file-item", "This belongs to the second file.", 1, 3);
const allItems = [outside, fileItems[1]!, fileItems[2]!, secondFileItem, fileItems[0]!];

function response(id: string, items = fileItems): ImportBatchContentResponse {
  return { batch: { id, fileName: id === batchA ? "街拍交流.md" : "另一份文件.md", createdAt: "2026-10-09T00:00:00.000Z" }, categories, items, unavailableCount: 0, version: 1 };
}

async function json(route: Route, body: unknown, status = 200): Promise<void> {
  await route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
}

async function mockBatchApp(page: Page) {
  const batches = new Map<string, ImportBatchContentResponse>([[batchA, response(batchA)], [batchB, response(batchB, [secondFileItem])]]);
  const paths: string[] = [];
  const writes: Array<{ path: string; body: Record<string, unknown> }> = [];
  let sessions = 0;
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    paths.push(path);
    const body = request.postDataJSON() as Record<string, unknown> | null;
    if (body) writes.push({ path, body });
    if (path === "/api/auth/session") return json(route, { user, csrfToken: "batch-csrf", capabilities: { emailAuthEnabled: false, selfRegistrationEnabled: false } });
    if (path === "/api/content") return json(route, { categories, items: allItems, version: 1 });
    if (path.startsWith("/api/practice/import-batches/")) {
      const content = batches.get(decodeURIComponent(path.slice("/api/practice/import-batches/".length)));
      return content ? json(route, content) : json(route, { error: { code: "NOT_FOUND", message: "该导入批次不存在或不属于当前账号。" } }, 404);
    }
    if (path === "/api/me/mistakes") return json(route, { items: [outside, fileItems[1], fileItems[2]].map((entry) => ({ item: entry, wrongCount: 2 })) });
    if (path === "/api/me/summary") return json(route, { totals: { sessions: 0, attempts: 0, correct: 0, accuracy: 0 } });
    if (path === "/api/practice/sessions") return json(route, { session: { id: `batch-session-${++sessions}`, startedAt: new Date().toISOString() } });
    if (path.endsWith("/finish")) return json(route, { ok: true });
    if (path.endsWith("/attempts")) {
      const target = allItems.find((entry) => entry.id === body?.itemId);
      return json(route, { correct: body?.answer === target?.english, summary: {} });
    }
    throw new Error(`Unexpected batch mock request: ${request.method()} ${path}`);
  });
  return {
    paths,
    writes,
    setBatch: (id: string, content: ImportBatchContentResponse) => { batches.set(id, content); },
    sessions: () => sessions,
    starts: () => writes.filter((entry) => entry.path === "/api/practice/sessions").map((entry) => entry.body)
  };
}

async function openBatch(page: Page, id = batchA): Promise<void> {
  await page.goto(`/practice?batch=${id}`);
  await expect(page.locator("#answerInput")).toBeEnabled();
}

async function visibleCycle(page: Page, count: number): Promise<string[]> {
  const english: string[] = [];
  for (let index = 0; index < count; index += 1) {
    await expect(page.locator("#positionText")).toHaveText(`${index + 1} / ${count}`);
    english.push((await page.locator("#targetWord").textContent())!);
    await page.locator("#nextButton").click();
  }
  return english;
}

test("file practice preserves file order, restricts categories and submits a batch-scoped session", async ({ page }) => {
  const mocked = await mockBatchApp(page);
  await openBatch(page);
  await expect(page.locator("#importBatchBanner")).toContainText("街拍交流.md");
  await expect(page.locator("#categorySelect")).toBeDisabled();
  await expect(page.locator("#categorySelect option")).toHaveCount(1);
  expect(await visibleCycle(page, 3)).toEqual(fileItems.map((entry) => entry.english));
  expect(mocked.paths).not.toContain("/api/content");
  expect(mocked.starts()).toEqual([{ mode: "sequential", importBatchId: batchA }]);
  await page.locator("#answerInput").fill(fileItems[0]!.english);
  await expect(page.locator("#targetWord")).toHaveText(fileItems[1]!.english);
  expect(mocked.writes.find((entry) => entry.path.endsWith("/attempts"))?.body.itemId).toBe(fileItems[0]!.id);
});

test("refresh retains file scope instead of opening the entire question bank", async ({ page }) => {
  const mocked = await mockBatchApp(page);
  await openBatch(page);
  await page.locator("#nextButton").click();
  await expect(page.locator("#targetWord")).toHaveText(fileItems[1]!.english);
  await page.reload();
  await expect(page.locator("#answerInput")).toBeEnabled();
  await expect(page).toHaveURL(new RegExp(`/practice\\?batch=${batchA}$`));
  await expect(page.locator("#targetWord")).toHaveText(fileItems[0]!.english);
  await expect(page.locator("#importBatchBanner")).toBeVisible();
  expect(mocked.paths.filter((path) => path === `/api/practice/import-batches/${batchA}`)).toHaveLength(2);
  expect(mocked.paths).not.toContain("/api/content");
  expect(mocked.starts().every((start) => start.importBatchId === batchA && !Object.hasOwn(start, "categoryId"))).toBeTruthy();
});

test("sequential, random and mistakes modes cannot include another file or unrelated mistakes", async ({ page }) => {
  const mocked = await mockBatchApp(page);
  await openBatch(page);
  await expect(page.locator("#mistakeStat")).toHaveText("2");
  await expect(page.locator("#reviewList")).not.toContainText(outside.english);
  await page.locator("#orderSelect").selectOption("shuffle");
  await expect(page.locator("#answerInput")).toBeEnabled();
  expect((await visibleCycle(page, 3)).sort()).toEqual(fileItems.map((entry) => entry.english).sort());
  await page.locator("#orderSelect").selectOption("mistakes");
  await expect(page.locator("#answerInput")).toBeEnabled();
  expect(await visibleCycle(page, 2)).toEqual([fileItems[1]!.english, fileItems[2]!.english]);
  await page.locator("#orderSelect").selectOption("order");
  await expect(page.locator("#answerInput")).toBeEnabled();
  expect(await visibleCycle(page, 3)).toEqual(fileItems.map((entry) => entry.english));
  expect(mocked.starts().map((start) => start.mode)).toEqual(["sequential", "random", "mistakes", "sequential"]);
  expect(mocked.starts().every((start) => start.importBatchId === batchA && !Object.hasOwn(start, "categoryId"))).toBeTruthy();
  expect(mocked.paths).not.toContain("/api/content");
});

test("a file whose items were all archived shows an explicit empty state without opening a session", async ({ page }) => {
  const mocked = await mockBatchApp(page);
  mocked.setBatch(batchA, { ...response(batchA, []), categories: [], unavailableCount: 3 });
  await page.goto(`/practice?batch=${batchA}`);
  await expect(page.locator("#targetWord")).toHaveText("本次文件暂无可练习内容");
  await expect(page.locator("#batchAvailabilityNote")).toContainText("另有 3 道已不可练习");
  await expect(page.locator("#answerInput")).toBeDisabled();
  await expect(page.locator("#positionText")).toHaveText("0 / 0");
  expect(mocked.sessions()).toBe(0);
  expect(mocked.paths).not.toContain("/api/content");
  await page.locator("#exitImportBatchButton").click();
  await expect(page).toHaveURL(/\/practice$/);
  await expect(page.locator("#answerInput")).toBeEnabled();
  await expect(page.locator("#importBatchBanner")).toHaveCount(0);
  expect(mocked.paths).toContain("/api/content");
});

test("missing or unowned batches fail explicitly and retry the batch endpoint only", async ({ page }) => {
  const mocked = await mockBatchApp(page);
  await page.goto("/practice?batch=not-owned");
  await expect(page.getByRole("heading", { name: "本次文件练习不可用" })).toBeVisible();
  await expect(page.getByText("该导入批次不存在或不属于当前账号。", { exact: true })).toBeVisible();
  await expect(page.locator("#answerInput")).toHaveCount(0);
  await page.locator("#retryButton").click();
  await expect.poll(() => mocked.paths.filter((path) => path.endsWith("/not-owned")).length).toBe(2);
  expect(mocked.paths).not.toContain("/api/content");
  expect(mocked.sessions()).toBe(0);
});

test("empty, duplicated and malformed batch parameters never fall back to global content", async ({ page }) => {
  const mocked = await mockBatchApp(page);
  for (const query of ["batch=", "batch=A&batch=B", "batch=%3Cscript%3E", "batch=../admin"]) {
    await page.goto(`/practice?${query}`);
    await expect(page.getByRole("heading", { name: "本次文件练习不可用" })).toBeVisible();
    await expect(page.getByText("本次文件练习链接无效，请从批量导入结果重新进入。", { exact: true })).toBeVisible();
    await expect(page.locator("#answerInput")).toHaveCount(0);
  }
  expect(mocked.paths.some((path) => path.startsWith("/api/practice/import-batches/"))).toBeFalsy();
  expect(mocked.paths).not.toContain("/api/content");
  expect(mocked.sessions()).toBe(0);
});

test("canceling exit keeps an unsynchronized attempt and retry sends its original idempotency key", async ({ page }) => {
  const mocked = await mockBatchApp(page);
  const attempts: unknown[] = [];
  await page.route("**/api/practice/sessions/*/attempts", async (route) => {
    attempts.push(route.request().postDataJSON());
    if (attempts.length === 1) return route.abort("failed");
    return json(route, { correct: false, summary: {} });
  });
  await openBatch(page);
  await page.locator("#answerInput").fill("not synchronized");
  await page.locator("#answerInput").press("Enter");
  await expect(page.locator("#syncStrip")).toBeVisible();
  const dialog = page.waitForEvent("dialog");
  page.once("dialog", (entry) => entry.dismiss());
  await page.locator("#exitImportBatchButton").click();
  expect((await dialog).message()).toContain("尚未同步");
  await expect(page).toHaveURL(new RegExp(`batch=${batchA}$`));
  await expect(page.locator("#answerInput")).toHaveValue("not synchronized");
  await expect(page.locator("#syncStrip")).toBeVisible();
  expect(mocked.sessions()).toBe(1);
  expect(mocked.paths).not.toContain("/api/content");
  await page.locator("#retrySyncButton").click();
  await expect(page.locator("#feedback")).toContainText("应输入");
  expect(attempts).toHaveLength(2);
  expect(attempts[1]).toEqual(attempts[0]);
  await page.locator("#exitImportBatchButton").click();
  await expect(page).toHaveURL(/\/practice$/);
  await expect(page.locator("#targetWord")).toHaveText(outside.english);
});

test("query-only batch navigation rerenders and canceling Back keeps the current unsynchronized file", async ({ page }) => {
  const mocked = await mockBatchApp(page);
  await openBatch(page, batchB);
  await expect(page.locator("#targetWord")).toHaveText(secondFileItem.english);
  await page.evaluate((id) => {
    history.pushState({}, "", `/practice?batch=${id}`);
    window.dispatchEvent(new PopStateEvent("popstate"));
  }, batchA);
  await expect(page.locator("#targetWord")).toHaveText(fileItems[0]!.english);
  await expect(page.locator("#answerInput")).toBeEnabled();
  expect(mocked.starts().map((start) => start.importBatchId)).toEqual([batchB, batchA]);
  await page.route("**/api/practice/sessions/*/attempts", (route) => route.abort("failed"));
  await page.locator("#answerInput").fill("pending answer in A");
  await page.locator("#answerInput").press("Enter");
  await expect(page.locator("#syncStrip")).toBeVisible();
  const canceled = page.waitForEvent("dialog");
  page.once("dialog", (dialog) => dialog.dismiss());
  await page.evaluate(() => history.back());
  expect((await canceled).message()).toContain("尚未同步");
  await expect(page).toHaveURL(new RegExp(`batch=${batchA}$`));
  await expect(page.locator("#answerInput")).toHaveValue("pending answer in A");
  await expect(page.locator("#targetWord")).toHaveText(fileItems[0]!.english);
  expect(mocked.sessions()).toBe(2);
  const accepted = page.waitForEvent("dialog");
  page.once("dialog", (dialog) => dialog.accept());
  await page.evaluate(() => history.back());
  await accepted;
  await expect(page).toHaveURL(new RegExp(`batch=${batchB}$`));
  await expect(page.locator("#targetWord")).toHaveText(secondFileItem.english);
  await expect(page.locator("#answerInput")).toBeEnabled();
  expect(mocked.starts().map((start) => start.importBatchId)).toEqual([batchB, batchA, batchB]);
  expect(mocked.paths).not.toContain("/api/content");
});

test("a content conflict refreshes the same file and excludes newly archived members", async ({ page }) => {
  const mocked = await mockBatchApp(page);
  const updated = { ...fileItems[1]!, english: "updated zebra", revision: 2 };
  await page.route("**/api/practice/sessions/*/attempts", async (route) => {
    mocked.setBatch(batchA, { ...response(batchA, [updated, fileItems[2]!]), version: 2, unavailableCount: 1 });
    return json(route, { error: { code: "CONTENT_CHANGED", message: "该题目版本已更新。" } }, 409);
  });
  await openBatch(page);
  await page.locator("#answerInput").fill(fileItems[0]!.english);
  await expect(page.locator("#targetWord")).toHaveText(updated.english);
  await expect(page.locator("#answerInput")).toBeEnabled();
  await expect(page.locator("#positionText")).toHaveText("1 / 2");
  await expect(page.locator("#batchAvailabilityNote")).toContainText("另有 1 道已不可练习");
  await expect(page.locator("#syncMessage")).toContainText("题库已更新并重新加载");
  await expect(page.locator("#doneStat")).toHaveText("0");
  expect(mocked.paths.filter((path) => path === `/api/practice/import-batches/${batchA}`)).toHaveLength(2);
  expect(mocked.paths).not.toContain("/api/content");
  expect(mocked.starts()).toHaveLength(2);
  expect(mocked.starts().every((start) => start.importBatchId === batchA)).toBeTruthy();
});

test("file practice controls and a long filename remain usable on a narrow phone", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const mocked = await mockBatchApp(page);
  const content = response(batchA);
  content.batch.fileName = "street-photography-english-conversation-".repeat(4) + ".md";
  mocked.setBatch(batchA, content);
  await openBatch(page);
  await expect(page.locator("#importBatchBanner")).toContainText(content.batch.fileName);
  await expect(page.locator("#exitImportBatchButton")).toBeVisible();
  await expect(page.locator("#answerInput")).toBeEnabled();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBeTruthy();
  await page.locator("#orderSelect").selectOption("mistakes");
  await expect(page.locator("#answerInput")).toBeEnabled();
  await expect(page.locator("#positionText")).toHaveText("1 / 2");
});

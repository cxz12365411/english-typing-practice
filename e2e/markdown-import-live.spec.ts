import { expect, test, type Page } from "@playwright/test";

async function login(page: Page, username = "md.owner") {
  await page.goto("/login");
  // Wait for session capabilities before checking the optional password tab.
  await expect(page.locator("#passwordLoginForm")).toBeAttached();
  const passwordTab = page.getByRole("tab", { name: "账号密码" });
  if (await passwordTab.count()) await passwordTab.click();
  await page.locator('#passwordLoginForm [name="username"]').fill(username);
  await page.locator('#passwordLoginForm [name="password"]').fill("E2eMarkdownOwner!2026");
  await page.locator("#passwordLoginForm").getByRole("button", { name: "登录", exact: true }).click();
  await expect(page).toHaveURL(username === "md.owner" ? /\/admin$/ : /\/practice$/);
}

let batchId = "";
test.describe.serial("live Markdown upload and batch practice", () => {
  test("uploads, preserves duplicates, publishes, practices, refreshes and reimports without overwriting", async ({ page }) => {
    await login(page);
    const original = (await (await page.request.get("/api/content")).json()).items.find((item: {english: string}) => item.english === "Hi, how are you?");
    const markdown = `# 浏览器真实导入验收\n## 句型：打招呼与开场\n| 英文 | 中文释义 | 中文谐音 |\n|---|---|---|\n| Hi, how are you? | 不应覆盖原释义 | 不应覆盖原谐音 |\n## 句型：MD真实浏览器新题\n| 英文 | 中文释义 | 中文谐音 |\n|---|---|---|\n| My camera is ready. | 我的相机准备好了。 | 买 卡梅若 伊兹 瑞迪。 |\n| Please face the light. | 请面向光线。 | 普利兹 费斯 德 莱特。 |`;
    const file = { name: "真实导入.md", mimeType: "text/markdown", buffer: Buffer.from(`\uFEFF${markdown.replace(/\n/g, "\r\n")}`) };
    await page.getByRole("button", { name: "批量导入", exact: true }).click();
    await page.locator("#markdownFileInput").setInputFiles(file);
    await expect(page.locator(".markdown-summary")).toContainText("新增 2 · 复用 1");
    await expect(page.locator("#markdownPreviewContent")).toContainText(original.meaning);
    await page.screenshot({ path: test.info().outputPath("markdown-import-desktop.png"), fullPage: true });
    await page.locator("#commitMarkdownImportButton").click();
    await expect(page).toHaveURL(/\/practice\?batch=/);
    batchId = new URL(page.url()).searchParams.get("batch")!;
    await expect(page.locator("#importBatchBanner")).toContainText("真实导入.md");
    await expect(page.locator("#positionText")).toHaveText("1 / 3");
    await expect(page.locator("#targetWord")).toHaveText("Hi, how are you?");
    await page.locator("#nextButton").click();
    await expect(page.locator("#targetWord")).toHaveText("My camera is ready.");
    await expect(page.locator("#pronunciationText")).toContainText("买 卡梅若");
    const before = await (await page.request.get("/api/me/summary")).json();
    await page.locator("#answerInput").fill("My camera is ready.");
    await expect(page.locator("#targetWord")).toHaveText("Please face the light.");
    await page.reload();
    await expect(page.locator("#positionText")).toHaveText("1 / 3");
    await expect(page.locator("#categorySelect")).toBeDisabled();
    const after = await (await page.request.get("/api/me/summary")).json();
    expect(after.totals.attempts).toBe(before.totals.attempts + 1);
    const content = await (await page.request.get("/api/content")).json();
    expect(content.items.find((item: {id: string}) => item.id === original.id)).toEqual(original);
    await page.getByRole("link", { name: "管理后台", exact: true }).click();
    await page.getByRole("button", { name: "批量导入", exact: true }).click();
    await page.locator("#markdownFileInput").setInputFiles(file);
    await expect(page.locator(".markdown-summary")).toContainText("新增 0 · 复用 3");
    await page.locator("#commitMarkdownImportButton").click();
    await expect(page).toHaveURL(/\/practice\?batch=/);
    const repeated = await (await page.request.get("/api/content")).json();
    expect(repeated.version).toBe(content.version);
    expect(repeated.items).toEqual(content.items);
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: test.info().outputPath("markdown-batch-mobile.png"), fullPage: true });
    await page.locator("#exitImportBatchButton").click();
    await expect(page).toHaveURL(/\/practice$/);
    await expect(page.locator("#importBatchBanner")).toHaveCount(0);
  });

  test("another account cannot open the importer-owned batch and gets no full-bank fallback", async ({ page }) => {
    await login(page, "md.other");
    const response = await page.request.get(`/api/practice/import-batches/${batchId}`);
    expect(response.status()).toBe(404);
    await page.goto(`/practice?batch=${batchId}`);
    await expect(page.getByRole("heading", { name: "本次文件练习不可用" })).toBeVisible();
    await expect(page.locator("#answerInput")).toHaveCount(0);
  });

  test("invalid Markdown is blocked and an archived imported item disappears from its batch", async ({ page }) => {
    await login(page);
    await page.getByRole("button", { name: "批量导入", exact: true }).click();
    await page.locator("#markdownFileInput").setInputFiles({ name: "错误.md", mimeType: "text/markdown", buffer: Buffer.from("## 漏字段\n**Missing translation.**\n谐音：测试") });
    await expect(page.locator("#markdownPreviewContent")).toContainText("中文释义不能为空");
    await expect(page.locator("#commitMarkdownImportButton")).toBeDisabled();
    const batch = await (await page.request.get(`/api/practice/import-batches/${batchId}`)).json();
    const item = batch.items.find((entry: {english: string}) => entry.english === "My camera is ready.");
    const session = await (await page.request.get("/api/auth/session")).json();
    const archived = await page.request.post(`/api/admin/items/${item.id}/archive`, { headers: { Origin: "http://localhost:4173", "X-CSRF-Token": session.csrfToken } });
    expect(archived.ok()).toBe(true);
    await page.goto(`/practice?batch=${batchId}`);
    await expect(page.locator("#positionText")).toHaveText("1 / 2");
    await expect(page.locator("#batchAvailabilityNote")).toContainText("1 道已不可练习");
    await page.locator("#nextButton").click();
    await expect(page.locator("#targetWord")).toHaveText("Please face the light.");
  });
});

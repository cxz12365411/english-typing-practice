import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";

const data = JSON.parse(readFileSync("gaokao-writing.json", "utf8"));
const application = data.essays[0];
const continuation = data.essays[6];

async function signIn(page: Page) {
  await page.goto("/login");
  await page.getByRole("tab", { name: "账号密码" }).click();
  const form = page.locator("#passwordLoginForm");
  await form.locator('[name="username"]').fill("md.other");
  await form.locator('[name="password"]').fill("E2eMarkdownOwner!2026");
  await form.getByRole("button", { name: "登录", exact: true }).click();
  await expect(page).toHaveURL(/\/practice$/);
  await expect(page.locator("#answerInput")).toBeEnabled();
}

test("a signed-in learner can practice Gaokao applications and read continuation material with the answer hidden", async ({ page }) => {
  await signIn(page);
  const categories = page.locator("#categorySelect");
  await expect(categories.locator("option").filter({ hasText: /^高考应用文：/ })).toHaveCount(6);
  await expect(categories.locator("option").filter({ hasText: /^高考读后续写：/ })).toHaveCount(4);

  await categories.selectOption({ label: `高考应用文：${application.title}` });
  const applicationFirst = application.paragraphs[0][0];
  const materials = page.locator(".gaokao-materials");
  const answer = page.locator(".cet4-preview");
  await expect(page.locator("#positionText")).toHaveText("1 / 6");
  await expect(page.locator("#targetWord")).toHaveText(applicationFirst.english);
  await materials.locator("summary").click();
  await expect(materials).toContainText("原创模拟题");
  await expect(materials.locator(".cet4-prompt")).toHaveText(application.prompt);
  await expect(materials.locator(".gaokao-reading")).toHaveCount(0);
  await answer.locator("summary").click();
  await expect(answer.locator(".cet4-english .is-current")).toHaveText(applicationFirst.english);

  const savedAttempt = page.waitForResponse(response =>
    response.request().method() === "POST" && /\/api\/practice\/sessions\/[^/]+\/attempts$/.test(new URL(response.url()).pathname)
  );
  await page.locator("#answerInput").fill(applicationFirst.english);
  const response = await savedAttempt;
  expect(response.ok()).toBeTruthy();
  expect((await response.json()).attempt.correct).toBe(true);
  await expect(page.locator("#positionText")).toHaveText("2 / 6");

  await categories.selectOption({ label: `高考读后续写：${continuation.title}` });
  await expect(page.locator("#positionText")).toHaveText("1 / 10");
  await expect(page.locator("#targetWord")).toHaveText(continuation.paragraphs[0][0].english);
  await expect(answer).not.toHaveAttribute("open", "");
  await answer.locator("summary").click();
  await expect(answer.locator(".cet4-english strong").first()).toHaveText(continuation.paragraphStarts[0].english);
  await page.locator("#showEnglish").uncheck();
  await expect(answer).toBeHidden();
  await expect(answer).not.toHaveAttribute("open", "");
  await materials.locator("summary").click();
  await expect(materials.locator(".gaokao-reading")).toHaveText(continuation.reading.english);
  await expect(materials.getByText(continuation.reading.summary)).toBeVisible();
  await expect(materials.getByText(continuation.paragraphStarts[1].english)).toBeVisible();
  await expect(materials.getByText(continuation.paragraphStarts[1].meaning)).toBeVisible();
  await expect(page.locator("#answerInput")).toBeEnabled();
  await page.locator("#showEnglish").check();
  await expect(answer.locator("summary")).toBeVisible();
  await expect(answer).not.toHaveAttribute("open", "");
});

for (const unavailable of ["missing", "mismatched"]) {
  test(`a ${unavailable} Gaokao writing preview leaves signed-in practice usable`, async ({ page }) => {
    const resourcePath = "/api/content-resources/gaokao-writing.json";
    await page.route(`**${resourcePath}`, route => {
      if (unavailable === "missing") return route.fulfill({ status: 503, body: "Unavailable" });
      const stale = structuredClone(data);
      stale.essays[6].paragraphs[0][0].meaning += "旧版译文。";
      return route.fulfill({ json: stale });
    });
    const previewResource = page.waitForResponse(response => new URL(response.url()).pathname === resourcePath);
    await signIn(page);
    expect((await previewResource).status()).toBe(unavailable === "missing" ? 503 : 200);
    await page.locator("#categorySelect").selectOption({ label: `高考读后续写：${continuation.title}` });
    if (unavailable === "mismatched") await expect(page.locator(".cet4-position")).toHaveText("高考读后续写");
    await expect(page.locator(".cet4-unavailable")).toBeVisible();
    await expect(page.locator(".gaokao-materials, .cet4-preview")).toHaveCount(0);
    await expect(page.locator("#targetWord")).toHaveText(continuation.paragraphs[0][0].english);
    await page.locator("#nextButton").click();
    await expect(page.locator("#positionText")).toHaveText("2 / 10");
    await expect(page.locator("#targetWord")).toHaveText(continuation.paragraphs[0][1].english);
    await expect(page.locator("#answerInput")).toBeEnabled();
  });
}

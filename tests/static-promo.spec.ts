import { expect, test, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";

async function openPractice(page: Page, entry = "/index.html") {
  await page.addInitScript(() => {
    Object.defineProperty(window, "speechSynthesis", {
      configurable: true,
      value: { getVoices: () => [], addEventListener() {}, removeEventListener() {}, cancel() {}, speak() {} }
    });
    Object.defineProperty(window, "SpeechSynthesisUtterance", { configurable: true, value: class {} });
  });
  await page.goto(entry);
  await expect(page.locator("#answerInput")).toBeEnabled();
  // Let the existing practice-page initial focus task finish before opening the demo.
  await page.clock.runFor(32);
}

async function freezeClock(page: Page) {
  await page.clock.install({ time: new Date("2026-10-27T00:00:00Z") });
  await page.clock.pauseAt(new Date("2026-10-27T00:00:01Z"));
}

for (const entry of ["/index.html", "/typing-practice.html"]) {
  test(`${entry} opens the optional demo without resetting the current answer`, async ({ page }) => {
    await freezeClock(page);
    await openPractice(page, entry);
    const details = page.locator("#homePromoDetails");
    const promo = page.locator("#homePromo");
    await expect(details).not.toHaveAttribute("open", "");
    await page.locator("#answerInput").fill("co");
    const original = await page.locator("#targetWord").textContent();
    await details.locator("summary").click();
    await expect(promo).toHaveAttribute("data-promo-duration", "8000");
    await expect(promo).toHaveAttribute("data-promo-status", "playing");
    await page.clock.runFor(1800);
    await expect(promo).toHaveAttribute("data-promo-stage", "arrows");
    await expect(page.locator("#answerInput")).toHaveValue("co");
    await expect(page.locator("#targetWord")).toHaveText(original!);
    await details.locator("summary").click();
    await expect(promo).toHaveAttribute("data-promo-status", "paused");
    const elapsed = await promo.getAttribute("data-promo-elapsed");
    await page.clock.runFor(4000);
    await expect(promo).toHaveAttribute("data-promo-elapsed", elapsed!);
    await expect(page.locator("#answerInput")).toHaveValue("co");
  });
}

test("the demo finishes once at eight seconds and can be replayed using the keyboard", async ({ page }) => {
  await freezeClock(page);
  await openPractice(page);
  await page.locator("#homePromoDetails summary").click();
  const promo = page.locator("#homePromo");
  await expect(promo).toHaveAttribute("data-promo-status", "playing");
  await promo.locator("[data-promo-replay]").click();
  await page.bringToFront();
  await page.clock.runFor(8100);
  await expect(promo).toHaveAttribute("data-promo-elapsed", "8000");
  await expect(promo).toHaveAttribute("data-promo-stage", "finish");
  await expect(promo).toHaveAttribute("data-promo-status", "finished");
  await page.clock.runFor(5000);
  await expect(promo).toHaveAttribute("data-promo-elapsed", "8000");
  await promo.locator("[data-promo-toggle]").focus();
  await page.keyboard.press("Enter");
  await expect(promo).toHaveAttribute("data-promo-status", "playing");
  await page.clock.runFor(1500);
  await expect(promo).toHaveAttribute("data-promo-stage", "arrows");
});

test("375px static demo fits inside the page and respects reduced motion", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 900 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await freezeClock(page);
  await openPractice(page);
  await page.locator("#homePromoDetails summary").click();
  const promo = page.locator("#homePromo");
  await expect(promo).toHaveAttribute("data-promo-stage", "finish");
  await expect(promo).toHaveAttribute("data-promo-status", "finished");
  await page.clock.runFor(9000);
  await expect(promo).toHaveAttribute("data-promo-elapsed", "8000");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const box = await promo.boundingBox();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(375);
  await promo.locator("[data-promo-toggle]").click();
  await page.clock.runFor(5000);
  await expect(promo).toHaveAttribute("data-promo-stage", "mnemonic");
  await expect(promo).toContainText("梅默伊");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  mkdirSync("out", { recursive: true });
  await page.screenshot({ path: "out/login-promo-static-mobile.png", fullPage: true, animations: "disabled" });
});

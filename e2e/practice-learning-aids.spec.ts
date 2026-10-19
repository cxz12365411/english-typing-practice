import { expect, test, type Page, type Route } from "@playwright/test";
import { readFileSync } from "node:fs";
import type { ContentItem } from "../web/src/types";

type AlignmentEntry = {
  english: string;
  meaning: string;
  zhParts: string[];
  groups: { en: number[]; zh: number[]; note?: string }[];
};
const alignmentData = JSON.parse(readFileSync("sentence-alignments.json", "utf8")) as {
  version: number;
  entries: AlignmentEntry[];
};
const hey = alignmentData.entries.find(entry => entry.english === "Hey, is this seat taken?")!;
const longest = alignmentData.entries.reduce((previous, entry) => entry.english.length > previous.english.length ? entry : previous);
const otherSentence = alignmentData.entries.find(entry => entry.english === "Hi, how are you?")!;
const dataUrl = /\/sentence-alignments(?:-[^/?]+)?\.json(?:\?.*)?$/;
const user = {
  id: "learning-aids-user", username: "learning.admin", displayName: "学习辅助回归管理员", role: "admin",
  status: "active", mustChangePassword: false, createdAt: "2026-10-18T00:00:00.000Z"
};

function item(entry: Pick<AlignmentEntry, "english" | "meaning">, index: number, kind: "word" | "sentence" = "sentence"): ContentItem {
  return {
    id: `original-item-${index}`, key: `original-content-key-${index}`, kind, categoryId: kind,
    english: entry.english, meaning: entry.meaning, pronunciation: "", revision: 7 + index,
    sortOrder: index, status: "published"
  };
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

async function json(route: Route, body: unknown): Promise<void> {
  await route.fulfill({ contentType: "application/json", body: JSON.stringify(body) });
}

async function mockApp(page: Page, items = [item(hey, 0), item(longest, 1), item(otherSentence, 2)]) {
  const categories = [...new Set(items.map(entry => entry.kind))].map((kind, index) => ({
    id: kind, name: kind === "word" ? "基础单词" : "日常句型", kind, sortOrder: index, status: "published"
  }));
  const requests: Array<{ path: string; body: Record<string, unknown> }> = [];
  const mistakes = new Map<string, number>();
  let sessions = 0;
  await page.route("**/api/**", async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const body = request.postDataJSON() as Record<string, unknown> | null;
    if (body) requests.push({ path, body });
    if (path === "/api/auth/session") return json(route, {
      user, csrfToken: "learning-aids-csrf", capabilities: { emailAuthEnabled: true, selfRegistrationEnabled: true }
    });
    if (path === "/api/content") return json(route, { categories, items, version: 1 });
    if (path === "/api/practice/import-batches/learning-fixture") return json(route, {
      categories, items, version: 1, unavailableCount: 0,
      batch: { id: "learning-fixture", fileName: "自定义练习.csv", createdAt: "2026-10-18T00:00:00.000Z" }
    });
    if (path === "/api/me/mistakes") return json(route, {
      items: items.filter(entry => mistakes.has(entry.id)).map(entry => ({ item: entry, wrongCount: mistakes.get(entry.id) }))
    });
    if (path === "/api/me/summary") return json(route, { totals: { sessions: 0, attempts: 0, correct: 0, accuracy: 0 } });
    if (path === "/api/practice/sessions") return json(route, { session: { id: `learning-session-${++sessions}`, startedAt: new Date().toISOString() } });
    if (path.endsWith("/attempts")) {
      const attempted = items.find(entry => entry.id === body?.itemId);
      const correct = body?.answer === attempted?.english;
      if (attempted && !correct) mistakes.set(attempted.id, (mistakes.get(attempted.id) ?? 0) + 1);
      return json(route, { correct, summary: {} });
    }
    if (path.endsWith("/finish")) return json(route, { ok: true });
    if (path === "/api/admin/users") return json(route, { users: [user] });
    if (path === "/api/admin/categories") return json(route, { categories });
    if (path === "/api/admin/items") return json(route, { items });
    if (path === "/api/admin/stats") return json(route, { stats: {} });
    if (path === "/api/admin/audit") return json(route, { entries: [] });
    throw new Error(`Unexpected learning-aids request: ${request.method()} ${path}`);
  });
  return { requests, sessions: () => sessions };
}

async function readyPractice(page: Page, path = "/practice"): Promise<void> {
  await page.goto(path);
  await expect(page.locator("#answerInput")).toBeEnabled();
}

type SpeechCall = { text: string; voiceURI: string | null; rate: number; pitch: number };
type SpeechHarness = { calls: SpeechCall[]; canceled: number; active: { text: string } | null };

test.beforeEach(async ({ page }) => {
  // Exercise real speech controls without emitting audio or depending on installed system voices.
  await page.addInitScript(() => {
    const voices = [
      { name: "Bells", voiceURI: "test.bells", lang: "en-US", default: true, localService: true },
      { name: "Alex", voiceURI: "test.alex", lang: "en-US", default: false, localService: true },
      { name: "Samantha", voiceURI: "test.samantha", lang: "en-US", default: false, localService: true },
      { name: "Samantha (Enhanced)", voiceURI: "test.samantha.enhanced", lang: "en-US", default: false, localService: true }
    ];
    const events = new EventTarget();
    const mock = {
      calls: [] as SpeechCall[], canceled: 0,
      active: null as SpeechSynthesisUtterance | null
    };
    Object.defineProperty(window, "speechSynthesis", {
      configurable: true,
      value: {
        getVoices: () => voices,
        addEventListener: events.addEventListener.bind(events),
        removeEventListener: events.removeEventListener.bind(events),
        cancel() {
          mock.canceled += 1;
          const previous = mock.active;
          mock.active = null;
          previous?.onerror?.({ error: "canceled" } as SpeechSynthesisErrorEvent);
        },
        speak(utterance: SpeechSynthesisUtterance) {
          mock.calls.push({ text: utterance.text, voiceURI: utterance.voice?.voiceURI ?? null, rate: utterance.rate, pitch: utterance.pitch });
          mock.active = utterance;
          utterance.onstart?.({} as SpeechSynthesisEvent);
        }
      }
    });
    Object.defineProperty(window, "SpeechSynthesisUtterance", {
      configurable: true,
      value: class { constructor(public text: string) {} }
    });
    (window as unknown as { __learningSpeech: SpeechHarness }).__learningSpeech = mock;
  });
});

async function speechState(page: Page): Promise<SpeechHarness> {
  return page.evaluate(() => {
    const state = (window as unknown as { __learningSpeech: SpeechHarness }).__learningSpeech;
    return { calls: state.calls, canceled: state.canceled, active: state.active ? { text: state.active.text } : null };
  });
}

async function geometryErrors(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const bounds = document.querySelector("#alignmentStage")!.getBoundingClientRect();
    return Array.from(document.querySelectorAll<SVGPathElement>(".alignment-path")).flatMap(path => {
      const token = document.querySelector(`.alignment-token[data-en-index="${path.dataset.enIndex}"]`)!.getBoundingClientRect();
      const indices = path.dataset.zhIndices!.split(",");
      const first = document.querySelector(`.alignment-zh[data-zh-index="${indices[0]}"]`)!.getBoundingClientRect();
      const last = document.querySelector(`.alignment-zh[data-zh-index="${indices.at(-1)}"]`)!.getBoundingClientRect();
      const start = path.getPointAtLength(0), end = path.getPointAtLength(path.getTotalLength());
      const errors: string[] = [];
      if (Math.abs(start.x - (token.left + token.width / 2 - bounds.left)) > 1) errors.push("source x");
      if (Math.abs(start.y - (token.bottom - bounds.top + 7)) > 1) errors.push("source y");
      if (end.x < first.left - bounds.left - 1 || end.x > last.right - bounds.left + 1) errors.push("target x");
      if (Math.abs(end.y - (first.top - bounds.top - 9)) > 1) errors.push("target y");
      return errors;
    });
  });
}

test("account practice loads the real 270 alignments and highlights the screenshot's shared phrase", async ({ page }) => {
  await mockApp(page);
  const dataResponse = page.waitForResponse(response => response.request().resourceType() === "fetch" && dataUrl.test(response.url()));
  await readyPractice(page);
  await expect(page.locator("#showAlignment")).toBeEnabled();
  expect(await page.evaluate(() => typeof (window as unknown as {
    WordAlignment?: { create: unknown };
  }).WordAlignment?.create)).toBe("function");
  const response = await dataResponse;
  expect(await response.json()).toEqual(alignmentData);
  if (process.env.E2E_WEB_MODE !== "development") {
    await expect(page.locator('script[type="module"][src^="/assets/index-"]')).toHaveCount(1);
    await expect(page.locator('script[src*="/@vite/client"]')).toHaveCount(0);
    expect(new URL(response.url()).pathname).toMatch(/^\/assets\/sentence-alignments-[^/]+\.json$/);
  }
  const writing = require("../cet4-writing.js").parse(JSON.parse(readFileSync("cet4-writing.json", "utf8")));
  expect(alignmentData.entries).toHaveLength(270 + writing.items.length);
  await expect(page.locator("#targetWord")).toHaveText(hey.english);
  await expect(page.locator("#meaningText")).toHaveText(hey.meaning);
  await expect(page.locator(".alignment-token")).toHaveCount(5);
  await expect(page.locator(".alignment-path")).toHaveCount(5);
  await page.locator('.alignment-token[data-en-index="1"]').click();
  await expect(page.locator(".alignment-token.is-highlighted")).toHaveText(["is", "taken"]);
  await expect(page.locator(".alignment-zh.is-highlighted")).toHaveText(["有人坐吗"]);
  await expect(page.locator(".alignment-path.is-highlighted")).toHaveCount(2);
  await expect(page.locator("#alignmentNote")).toContainText("is … taken → 有人坐吗");
  await expect(page.locator("#alignmentNote")).toContainText("合译");
  await page.locator('.alignment-token[data-en-index="2"]').focus();
  await expect(page.locator(".alignment-zh.is-highlighted")).toHaveText(["这个"]);
  await page.keyboard.press("Escape");
  await expect(page.locator("#alignmentStage")).not.toHaveClass(/has-highlight/);
  expect(await geometryErrors(page)).toEqual([]);
});

test("words from the original 850 retain their whole definition with one arrow", async ({ page }) => {
  const words = Array.from(readFileSync("basic-english-850.md", "utf8").matchAll(/^- \*\*(.+?)\*\*：(.+)$/gm), match => ({
    english: match[1].trim(), meaning: match[2].trim()
  }));
  expect(words).toHaveLength(850);
  const selected = [words[0], words[424], words[849]].map((entry, index) => item(entry, index, "word"));
  await mockApp(page, selected);
  await readyPractice(page);
  for (const entry of selected) {
    await expect(page.locator("#targetWord")).toHaveText(entry.english);
    await expect(page.locator("#meaningText")).toHaveText(entry.meaning);
    await expect(page.locator(".alignment-token")).toHaveCount(1);
    await expect(page.locator(".alignment-path")).toHaveCount(1);
    await page.locator(".alignment-token").click();
    await expect(page.locator(".alignment-zh.is-highlighted")).toHaveText([entry.meaning]);
    await page.locator("#nextButton").click();
  }
});

test("changed translations and unknown imported sentences use plain text without invented arrows", async ({ page }) => {
  const changed = item({ ...hey, meaning: "你好，请问这里可以坐吗？" }, 0);
  const imported = item({ english: "Please inspect the custom sample tomorrow.", meaning: "请明天检查自定义样品。" }, 1);
  await mockApp(page, [changed, imported]);
  const dataResponse = page.waitForResponse(response => response.request().resourceType() === "fetch" && dataUrl.test(response.url()));
  await readyPractice(page, "/practice?batch=learning-fixture");
  await dataResponse;
  await expect(page.locator("#importBatchBanner")).toContainText("自定义练习.csv");
  for (const entry of [changed, imported]) {
    await expect(page.locator("#targetWord")).toHaveText(entry.english);
    await expect(page.locator("#meaningText")).toHaveText(entry.meaning);
    await expect(page.locator(".alignment-token, .alignment-path")).toHaveCount(0);
    await expect(page.locator("#alignmentNote")).toBeHidden();
    await page.locator("#nextButton").click();
  }
});

test("delayed alignment data preserves the answer currently being typed", async ({ page }) => {
  await mockApp(page);
  const delayed = deferred();
  let requested = false;
  await page.route(dataUrl, async route => {
    if (route.request().resourceType() !== "fetch") return route.continue();
    requested = true;
    await delayed.promise;
    await route.continue();
  });
  try {
    await readyPractice(page);
    await expect.poll(() => requested).toBeTruthy();
    await page.locator("#answerInput").fill("Hey, is this");
    await expect(page.locator(".alignment-path")).toHaveCount(0);
    delayed.resolve();
    await expect(page.locator(".alignment-path")).toHaveCount(5);
    await expect(page.locator("#answerInput")).toHaveValue("Hey, is this");
    await expect(page.locator("#positionText")).toHaveText("1 / 3");
    await expect(page.locator("#doneStat")).toHaveText("0");
  } finally {
    delayed.resolve();
  }
});

test("an unavailable alignment asset leaves typing and the original prompt usable", async ({ page }) => {
  const mocked = await mockApp(page);
  await page.route(dataUrl, route => route.request().resourceType() === "fetch" ? route.abort("failed") : route.continue());
  await readyPractice(page);
  await expect(page.locator("#targetWord")).toHaveText(hey.english);
  await expect(page.locator("#meaningText")).toHaveText(hey.meaning);
  await expect(page.locator(".alignment-path")).toHaveCount(0);
  await expect(page.locator("#alignmentNote")).toBeHidden();
  await page.locator("#answerInput").fill(hey.english);
  await expect.poll(() => mocked.requests.filter(request => request.path.endsWith("/attempts")).length).toBe(1);
  await expect(page.locator("#targetWord")).toHaveText(longest.english);
});

test("arrow preference survives refresh and hidden English exposes no alignment clues", async ({ page }) => {
  await mockApp(page);
  await readyPractice(page);
  await expect(page.locator(".alignment-path")).toHaveCount(5);
  await page.locator("#showAlignment").uncheck();
  await expect(page.locator(".alignment-path")).toHaveCount(0);
  await page.reload();
  await expect(page.locator("#answerInput")).toBeEnabled();
  await expect(page.locator("#showAlignment")).not.toBeChecked();
  await expect(page.locator(".alignment-token")).toHaveCount(0);
  await page.locator("#showAlignment").check();
  await expect(page.locator(".alignment-path")).toHaveCount(5);
  await page.locator('.alignment-token[data-en-index="1"]').click();
  await page.locator("#showEnglish").uncheck();
  await expect(page.locator("#targetWord")).toHaveText("•".repeat(hey.english.length));
  await expect(page.locator("#meaningText")).toHaveText(hey.meaning);
  await expect(page.locator(".alignment-token, .alignment-path")).toHaveCount(0);
  await expect(page.locator("#alignmentNote")).toBeHidden();
  await expect(page.locator("#alignmentNote")).toBeEmpty();
  await expect(page.locator("#alignmentScroll")).not.toHaveAttribute("aria-label");
  await page.locator("#showEnglish").check();
  await expect(page.locator(".alignment-path")).toHaveCount(5);
});

test("the longest sentence scrolls inside a 375px diagram and arrows follow a resize", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await mockApp(page, [item(longest, 0)]);
  await readyPractice(page);
  await expect(page.locator(".alignment-path").first()).toBeAttached();
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
  const dimensions = await page.locator("#alignmentScroll").evaluate(element => ({ width: element.clientWidth, content: element.scrollWidth }));
  expect(dimensions.content).toBeGreaterThan(dimensions.width);
  await page.locator("#alignmentScroll").evaluate(element => { element.scrollLeft = element.scrollWidth; });
  await expect.poll(() => page.locator("#alignmentScroll").evaluate(element => element.scrollLeft)).toBeGreaterThan(0);
  await expect.poll(() => geometryErrors(page)).toEqual([]);
  await page.setViewportSize({ width: 1000, height: 900 });
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(1000);
  await expect.poll(() => geometryErrors(page)).toEqual([]);
  await expect(page.locator("#targetWord")).toHaveText(longest.english);
  await expect(page.locator("#meaningText")).toHaveText(longest.meaning);
});

test("leaving practice disposes delayed data and returning creates only the current diagram", async ({ page }) => {
  const mocked = await mockApp(page);
  const delayed = deferred();
  let loads = 0;
  await page.route(dataUrl, async route => {
    if (route.request().resourceType() !== "fetch") return route.continue();
    loads += 1;
    if (loads === 1) {
      await delayed.promise;
      // The first controller aborts its fetch on navigation.
      await route.continue().catch(() => undefined);
    } else await route.continue();
  });
  try {
    await readyPractice(page);
    await expect.poll(() => loads).toBe(1);
    await page.getByRole("link", { name: "管理后台", exact: true }).click();
    await expect(page.locator("#alignmentStage")).toHaveCount(0);
    await page.getByRole("link", { name: "练习", exact: true }).click();
    await expect(page.locator("#answerInput")).toBeEnabled();
    await expect(page.locator(".alignment-path")).toHaveCount(5);
    await page.locator("#answerInput").fill("Hey,");
    delayed.resolve();
    await page.evaluate(() => {
      window.dispatchEvent(new Event("resize"));
      document.fonts.dispatchEvent(new Event("loadingdone"));
    });
    await expect(page.locator("#alignmentStage")).toHaveCount(1);
    await expect(page.locator(".alignment-path")).toHaveCount(5);
    await expect(page.locator("#answerInput")).toHaveValue("Hey,");
    await expect(page.locator("#doneStat")).toHaveText("0");
    expect(mocked.sessions()).toBe(2);
    await page.locator('.alignment-token[data-en-index="1"]').click();
    await expect(page.locator(".alignment-token.is-highlighted")).toHaveText(["is", "taken"]);
  } finally {
    delayed.resolve();
  }
});

test("arrow interaction preserves cloud item identity, revision, answer and mistake tracking", async ({ page }) => {
  const original = item(hey, 0);
  const mocked = await mockApp(page, [original, item(longest, 1)]);
  await readyPractice(page);
  await expect(page.locator(".alignment-path")).toHaveCount(5);
  await page.locator('.alignment-token[data-en-index="1"]').click();
  await page.locator("#answerInput").fill("wrong answer");
  await page.locator("#answerInput").press("Enter");
  await expect(page.locator("#feedback")).toContainText(hey.english);
  await expect(page.locator("#reviewList")).toContainText(hey.english);
  await page.locator("#answerInput").fill(hey.english);
  await expect.poll(() => mocked.requests.filter(request => request.path.endsWith("/attempts")).length).toBe(2);
  const attempts = mocked.requests.filter(request => request.path.endsWith("/attempts"));
  expect(attempts.map(request => ({ itemId: request.body.itemId, itemRevision: request.body.itemRevision, answer: request.body.answer }))).toEqual([
    { itemId: original.id, itemRevision: original.revision, answer: "wrong answer" },
    { itemId: original.id, itemRevision: original.revision, answer: hey.english }
  ]);
  await expect(page.locator("#targetWord")).toHaveText(longest.english);
  await expect(page.locator("#doneStat")).toHaveText("2");
});

test("speech recommends enhanced Samantha and reads the original sentence despite highlighted tokens", async ({ page }) => {
  await mockApp(page);
  await readyPractice(page);
  await expect(page.locator(".alignment-path")).toHaveCount(5);
  await expect(page.locator("#voiceSelect option").first()).toContainText("Samantha (Enhanced)");
  await page.locator('.alignment-token[data-en-index="1"]').click();
  await page.locator("#speakButton").click();
  expect((await speechState(page)).calls).toEqual([
    { text: hey.english, voiceURI: "test.samantha.enhanced", rate: 1, pitch: 1 }
  ]);
  await page.locator("#previewVoiceBtn").click();
  expect((await speechState(page)).calls.at(-1)).toEqual({
    text: "Hello! Let's practice English together.", voiceURI: "test.samantha.enhanced", rate: 1, pitch: 1
  });
});

test("manual speech voice and rate survive refresh and the longest sentence has no added slowdown", async ({ page }) => {
  await mockApp(page, [item(longest, 0)]);
  await readyPractice(page);
  await page.locator("#voiceSelect").selectOption("test.alex");
  await page.locator("#speechRate").fill("1.15");
  await page.locator("#speechRate").dispatchEvent("input");
  await expect(page.locator("#speechRateValue")).toHaveText("1.15 倍");
  await page.reload();
  await expect(page.locator("#answerInput")).toBeEnabled();
  await expect(page.locator("#voiceSelect")).toHaveValue("test.alex");
  await expect(page.locator("#speechRate")).toHaveValue("1.15");
  await page.locator("#speakButton").click();
  expect((await speechState(page)).calls).toEqual([
    { text: longest.english, voiceURI: "test.alex", rate: 1.15, pitch: 1 }
  ]);
});

test("rapid navigation and disabling automatic speech cancel old audio and queued utterances", async ({ page }) => {
  await mockApp(page);
  await readyPractice(page);
  await page.locator("#autoSpeak").check();
  expect((await speechState(page)).calls.map(call => call.text)).toEqual([hey.english]);
  const cancellations = (await speechState(page)).canceled;
  await page.evaluate(() => {
    const next = document.querySelector<HTMLButtonElement>("#nextButton")!;
    next.click();
    next.click();
    const automatic = document.querySelector<HTMLInputElement>("#autoSpeak")!;
    automatic.checked = false;
    automatic.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await expect(page.locator("#targetWord")).toHaveText(otherSentence.english);
  await page.waitForTimeout(350);
  const stopped = await speechState(page);
  expect(stopped.calls.map(call => call.text)).toEqual([hey.english]);
  expect(stopped.active).toBeNull();
  expect(stopped.canceled).toBeGreaterThan(cancellations);
  await page.locator("#speakButton").click();
  expect((await speechState(page)).calls.at(-1)?.text).toBe(otherSentence.english);
  await page.getByRole("link", { name: "管理后台", exact: true }).click();
  expect((await speechState(page)).active).toBeNull();
});

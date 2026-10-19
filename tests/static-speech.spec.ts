import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";

type Voice = {
  name: string;
  voiceURI: string;
  lang: string;
  default: boolean;
  localService: boolean;
};

function voice(name: string, voiceURI: string, lang = "en-US", isDefault = false): Voice {
  return { name, voiceURI, lang, default: isDefault, localService: true };
}

const samantha = voice("Samantha", "com.apple.samantha");
const enhanced = voice("Samantha (Enhanced)", "com.apple.samantha.enhanced");
const premium = voice("Samantha", "com.apple.samantha.premium");
const alex = voice("Alex", "com.apple.alex");
const british = voice("Daniel", "com.apple.daniel", "en-GB", true);
const effect = voice("Bells", "com.apple.bells", "en-US", true);
const chinese = voice("Tingting", "com.apple.tingting", "zh-CN", true);
const ordinaryVoices = [effect, chinese, british, alex, samantha];

const longSentence = "I would like to practice English every day so that I can speak more naturally.";
const words = "## 1. 测试 3 个\n- **apple**：苹果\n- **book**：书\n- **cat**：猫\n";
const sentences = `## 1. 测试句型\n| English | 中文 |\n|---|---|\n| Hello! | 你好 |\n| ${longSentence} | 长句测试 |\n`;

async function openPractice(page: Page, options: {
  voices?: Voice[];
  supported?: boolean;
  saved?: unknown;
  entry?: string;
} = {}) {
  await page.addInitScript(({ initialVoices, supported, saved }) => {
    if (saved !== undefined && !sessionStorage.getItem("speechTestSeeded")) {
      localStorage.setItem("basicTypingSpeechSettings", JSON.stringify(saved));
      sessionStorage.setItem("speechTestSeeded", "1");
    }
    const w = window as any;
    if (!supported) {
      delete w.speechSynthesis;
      delete w.SpeechSynthesisUtterance;
      return;
    }
    const target = new EventTarget();
    const mock = {
      voices: initialVoices,
      calls: [] as any[],
      active: null as any,
      canceled: 0,
      throwSpeak: false,
      setVoices(voices: any[]) {
        mock.voices = voices;
        target.dispatchEvent(new Event("voiceschanged"));
      },
      error(error: string, index = mock.calls.length - 1) {
        mock.calls[index]?.onerror?.({ error });
      },
      finish() {
        mock.active?.onend?.();
        mock.active = null;
      }
    };
    Object.defineProperty(w, "speechSynthesis", {
      configurable: true,
      value: {
        getVoices: () => mock.voices,
        addEventListener: target.addEventListener.bind(target),
        removeEventListener: target.removeEventListener.bind(target),
        cancel() {
          mock.canceled += 1;
          const previous = mock.active;
          mock.active = null;
          previous?.onerror?.({ error: "canceled" });
        },
        speak(utterance: any) {
          if (mock.throwSpeak) throw new Error("Simulated synthesis failure");
          mock.calls.push(utterance);
          mock.active = utterance;
          utterance.onstart?.();
        }
      }
    });
    w.SpeechSynthesisUtterance = class {
      text: string;
      constructor(text: string) { this.text = text; }
    };
    w.__speechTest = mock;
  }, { initialVoices: options.voices ?? ordinaryVoices, supported: options.supported ?? true, saved: options.saved });
  await page.route("**/cet4-writing.json", route => route.fulfill({ status: 404, body: "Not part of this fixture" }));
  await page.route("**/basic-english-850.md", route => route.fulfill({ contentType: "text/markdown", body: words }));
  await page.route("**/daily-english-high-frequency-sentences.md", route => route.fulfill({ contentType: "text/markdown", body: sentences }));
  await page.goto(options.entry ?? "/index.html");
  await expect(page.locator("#answerInput")).toBeEnabled();
  await expect(page.locator("#targetWord")).toHaveText("apple");
}

async function calls(page: Page) {
  return page.evaluate(() => (window as any).__speechTest.calls.map((item: any) => ({
    text: item.text, voiceURI: item.voice?.voiceURI, lang: item.lang, rate: item.rate, pitch: item.pitch
  })));
}

async function setRate(page: Page, rate: number) {
  await page.locator("#speechRate").fill(String(rate));
  await page.locator("#speechRate").dispatchEvent("input");
}

async function pauseClock(page: Page) {
  await page.clock.install({ time: new Date("2026-01-01T00:00:00Z") });
  await page.clock.pauseAt(new Date("2026-01-01T00:00:01Z"));
}

test("both static entry points remain byte-identical", () => {
  expect(readFileSync("typing-practice.html", "utf8")).toBe(readFileSync("index.html", "utf8"));
});

test("automatically prefers premium, enhanced, and ordinary Samantha in order", async ({ page }) => {
  await openPractice(page, { voices: [...ordinaryVoices, enhanced, premium] });
  await expect(page.locator("#voiceSelect")).toHaveValue("");
  await expect(page.locator("#voiceSelect option")).toHaveCount(7);
  await page.locator("#previewVoiceBtn").click();
  expect((await calls(page)).at(-1)).toMatchObject({ voiceURI: premium.voiceURI, rate: 1, pitch: 1 });

  await page.evaluate(voices => (window as any).__speechTest.setVoices(voices), [...ordinaryVoices, enhanced]);
  await page.locator("#speakBtn").click();
  expect((await calls(page)).at(-1)?.voiceURI).toBe(enhanced.voiceURI);

  await page.evaluate(voices => (window as any).__speechTest.setVoices(voices), ordinaryVoices);
  await page.locator("#speakBtn").click();
  expect((await calls(page)).at(-1)?.voiceURI).toBe(samantha.voiceURI);
});

test("fallback prefers ordinary US English, never automatically selecting effects", async ({ page }) => {
  await openPractice(page, { voices: [effect, chinese, british, alex] });
  await page.locator("#speakBtn").click();
  expect((await calls(page)).at(-1)?.voiceURI).toBe(alex.voiceURI);
  await page.evaluate(() => (window as any).__speechTest.finish());
  await page.evaluate(voices => (window as any).__speechTest.setVoices(voices), [effect, chinese]);
  await expect(page.locator("#speakBtn")).toBeDisabled();
  await expect(page.locator("#speechStatus")).toContainText("英语声音");
  await expect(page.locator("#answerInput")).toBeEnabled();
  await page.locator("#voiceSelect").selectOption(effect.voiceURI);
  await expect(page.locator("#speakBtn")).toBeEnabled();
  await page.locator("#speakBtn").click();
  expect((await calls(page)).at(-1)?.voiceURI).toBe(effect.voiceURI);
});

test("manual voice and rate survive refresh and delayed voiceschanged events", async ({ page }) => {
  await openPractice(page);
  await page.locator("#voiceSelect").selectOption(alex.voiceURI);
  await setRate(page, 1.15);
  await expect(page.locator("#speechRateValue")).toHaveText("1.15 倍");
  await page.evaluate(voices => (window as any).__speechTest.setVoices(voices), [...ordinaryVoices, premium]);
  await expect(page.locator("#voiceSelect")).toHaveValue(alex.voiceURI);
  await page.locator("#previewVoiceBtn").click();
  expect((await calls(page)).at(-1)).toMatchObject({ voiceURI: alex.voiceURI, rate: 1.15, pitch: 1 });
  await page.reload();
  await expect(page.locator("#voiceSelect")).toHaveValue(alex.voiceURI);
  await expect(page.locator("#speechRate")).toHaveValue("1.15");
  await page.locator("#speakBtn").click();
  expect((await calls(page)).at(-1)).toMatchObject({ voiceURI: alex.voiceURI, rate: 1.15 });
  await page.locator("#voiceSelect").selectOption("");
  await page.reload();
  await expect(page.locator("#voiceSelect")).toHaveValue("");
  await page.locator("#speakBtn").click();
  expect((await calls(page)).at(-1)?.voiceURI).toBe(samantha.voiceURI);
});

test("an initially absent saved voice is restored once voices arrive", async ({ page }) => {
  await openPractice(page, { voices: [], saved: { ...alex, rate: 0.85 } });
  await expect(page.locator("#speakBtn")).toBeDisabled();
  await expect(page.locator("#speechRate")).toHaveValue("0.85");
  await page.evaluate(voices => (window as any).__speechTest.setVoices(voices), [samantha]);
  await expect(page.locator("#speechStatus")).toContainText("暂不可用");
  await page.locator("#speakBtn").click();
  expect((await calls(page)).at(-1)?.voiceURI).toBe(samantha.voiceURI);
  await page.evaluate(() => (window as any).__speechTest.finish());
  await page.evaluate(voices => (window as any).__speechTest.setVoices(voices), ordinaryVoices);
  await expect(page.locator("#voiceSelect")).toHaveValue(alex.voiceURI);
  await page.locator("#previewVoiceBtn").click();
  expect((await calls(page)).at(-1)).toMatchObject({ voiceURI: alex.voiceURI, rate: 0.85 });
});

test("word, short sentence, long sentence, and preview use the selected rate", async ({ page }) => {
  await openPractice(page, { entry: "/typing-practice.html" });
  await setRate(page, 1.25);
  await page.locator("#speakBtn").click();
  await page.locator("#categorySelect").selectOption("句型：测试句型");
  await page.locator("#speakBtn").click();
  await page.locator("#nextBtn").click();
  await expect(page.locator("#targetWord")).toHaveText(longSentence);
  await page.locator("#speakBtn").click();
  await page.locator("#previewVoiceBtn").click();
  const utterances = await calls(page);
  expect(utterances.map(item => item.text)).toEqual(["apple", "Hello!", longSentence, "Hello! Let's practice English together."]);
  expect(utterances.every(item => item.rate === 1.25 && item.pitch === 1)).toBe(true);
  await expect(page.locator("#speechRate")).toHaveAttribute("min", "0.75");
  await expect(page.locator("#speechRate")).toHaveAttribute("max", "1.25");
});

test("repeated play cancels the old utterance and ignores its late error", async ({ page }) => {
  await openPractice(page);
  const startCancels = await page.evaluate(() => (window as any).__speechTest.canceled);
  await page.locator("#speakBtn").click();
  await page.locator("#speakBtn").click();
  expect(await calls(page)).toHaveLength(2);
  expect(await page.evaluate(() => (window as any).__speechTest.canceled)).toBe(startCancels + 2);
  await page.evaluate(() => (window as any).__speechTest.error("network", 0));
  await expect(page.locator("#speechStatus")).toContainText("正在朗读");
  await expect(page.locator("#speechStatus")).not.toHaveClass(/bad/);
  await page.locator("#nextBtn").click();
  expect(await page.evaluate(() => (window as any).__speechTest.active)).toBeNull();
  await expect(page.locator("#speechStatus")).not.toHaveClass(/bad/);
});

test("rapid navigation and disabling autoplay cancel pending speech", async ({ page }) => {
  await openPractice(page);
  await pauseClock(page);
  await page.locator("#autoSpeak").check();
  expect((await calls(page)).map(item => item.text)).toEqual(["apple"]);
  await page.locator("#nextBtn").click();
  await page.locator("#nextBtn").click();
  await page.clock.runFor(200);
  expect((await calls(page)).map(item => item.text)).toEqual(["apple", "cat"]);
  await page.locator("#nextBtn").click();
  await page.locator("#autoSpeak").uncheck();
  await page.clock.runFor(300);
  expect((await calls(page)).map(item => item.text)).toEqual(["apple", "cat"]);
  expect(await page.evaluate(() => (window as any).__speechTest.active)).toBeNull();
});

test("a manual play supersedes pending automatic speech for the same item", async ({ page }) => {
  await openPractice(page);
  await pauseClock(page);
  await page.locator("#autoSpeak").check();
  await page.locator("#nextBtn").click();
  await page.locator("#speakBtn").click();
  await page.clock.runFor(300);
  expect((await calls(page)).map(item => item.text)).toEqual(["apple", "book"]);
});

test("hiding the page prevents a queued answer transition from starting speech", async ({ page }) => {
  await openPractice(page);
  await pauseClock(page);
  await page.locator("#autoSpeak").check();
  await page.locator("#answerInput").fill("apple");
  await page.evaluate(() => {
    Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await page.clock.runFor(1000);
  expect((await calls(page)).map(item => item.text)).toEqual(["apple"]);
  expect(await page.evaluate(() => (window as any).__speechTest.active)).toBeNull();
});

test("real errors are visible, intentional cancel and interruption are quiet", async ({ page }) => {
  await openPractice(page);
  await page.locator("#speakBtn").click();
  await page.evaluate(() => (window as any).__speechTest.error("network"));
  await expect(page.locator("#speechStatus")).toHaveClass(/bad/);
  await expect(page.locator("#speechStatus")).toContainText("朗读失败");
  await page.locator("#speakBtn").click();
  await page.evaluate(() => (window as any).__speechTest.error("not-allowed"));
  await expect(page.locator("#speechStatus")).toContainText("请先点击");
  for (const error of ["canceled", "interrupted"]) {
    await page.locator("#speakBtn").click();
    await page.evaluate(value => (window as any).__speechTest.error(value), error);
    await expect(page.locator("#speechStatus")).not.toHaveClass(/bad/);
  }
  await page.evaluate(() => { (window as any).__speechTest.throwSpeak = true; });
  await page.locator("#speakBtn").click();
  await expect(page.locator("#speechStatus")).toContainText("朗读失败");
});

test("typing and mistake review continue when speech is unsupported", async ({ page }) => {
  await openPractice(page, { supported: false });
  await expect(page.locator("#speechStatus")).toContainText("不支持朗读");
  await expect(page.locator("#speakBtn")).toBeDisabled();
  await expect(page.locator("#previewVoiceBtn")).toBeDisabled();
  await expect(page.locator("#autoSpeak")).toBeDisabled();
  await page.locator("#answerInput").fill("incorrect");
  await page.locator("#answerInput").press("Enter");
  await expect(page.locator("#mistakeStat")).toHaveText("1");
  await expect(page.locator("#reviewList")).toContainText("apple");
  await page.locator("#orderSelect").selectOption("mistakes");
  await expect(page.locator("#positionText")).toHaveText("1 / 1");
  await page.locator("#answerInput").fill("APPLE");
  await expect(page.locator("#feedback")).toHaveText("正确");
  await expect(page.locator("#mistakeStat")).toHaveText("0");
  await expect(page.locator("#accuracyStat")).toHaveText("100%");
});

test("correct-answer timer cannot skip an item after manual navigation", async ({ page }) => {
  await openPractice(page);
  await pauseClock(page);
  await page.locator("#answerInput").fill("apple");
  await expect(page.locator("#feedback")).toHaveText("正确");
  await page.locator("#nextBtn").click();
  await page.clock.runFor(500);
  await expect(page.locator("#targetWord")).toHaveText("book");
  await expect(page.locator("#doneStat")).toHaveText("1");
});

test("mobile speech settings fit the viewport and practice remains usable", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await openPractice(page);
  for (const id of ["voiceSelect", "speechRate", "previewVoiceBtn"]) {
    await expect(page.locator(`#${id}`)).toBeVisible();
    const box = await page.locator(`#${id}`).boundingBox();
    expect(box?.x).toBeGreaterThanOrEqual(0);
    expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(375);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
  await page.locator("#previewVoiceBtn").click();
  expect(await calls(page)).toHaveLength(1);
  await page.locator("#answerInput").fill("apple");
  await expect(page.locator("#feedback")).toHaveText("正确");
});

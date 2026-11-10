import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSpeechController, type SpeechController } from "../src/speech";

class TestOption {
  disabled = false;
  constructor(public text: string, public value: string) {}
}

class TestElement extends EventTarget {
  disabled = false;
  hidden = false;
  value = "";
  textContent = "";
  className = "";
  options: TestOption[] = [];
  get selectedOptions(): TestOption[] { return this.options.filter((option) => option.value === this.value); }
  replaceChildren(...children: TestOption[]): void { this.options = children; }
  add(option: TestOption): void { this.options.push(option); }
}

class TestUtterance {
  lang = "";
  rate = 1;
  pitch = 1;
  voice: SpeechSynthesisVoice | null = null;
  onstart: (() => void) | null = null;
  onend: (() => void) | null = null;
  onerror: ((event: { error: string }) => void) | null = null;
  constructor(public text: string) {}
}

class TestAudio {
  src = "";
  preload = "";
  preservesPitch = false;
  playbackRate = 1;
  paused = true;
  onplaying: (() => void) | null = null;
  onended: (() => void) | null = null;
  onerror: (() => void) | null = null;
  calls: { src: string; rate: number; preservesPitch: boolean }[] = [];
  play = vi.fn((): Promise<void> => {
    this.paused = false;
    this.calls.push({ src: this.src, rate: this.playbackRate, preservesPitch: this.preservesPitch });
    this.onplaying?.();
    return Promise.resolve();
  });
  pause = vi.fn(() => { this.paused = true; });
  removeAttribute(name: string): void { if (name === "src") this.src = ""; }
  load = vi.fn();
}

const catalog = {
  available: true,
  voices: ["01", "02", "03", "04", "05"].map((id, i) => ({
    id, name: ["温柔陪练", "亲切学姐", "安静讲解", "自然教师", "清亮助手"][i], previewUrl: `/api/speech/preview/${id}`
  })),
  entries: [
    { itemId: "apple-id", english: "apple", textKey: "a".repeat(64), voiceIds: ["01", "02", "03", "04", "05"] },
    { itemId: "book-id", english: "book", textKey: "b".repeat(64), voiceIds: ["01", "02", "03", "04", "05"] }
  ]
};

function voice(name: string, voiceURI: string, lang = "en-US", isDefault = false): SpeechSynthesisVoice {
  return { name, voiceURI, lang, default: isDefault, localService: true };
}

const samantha = voice("Samantha", "samantha");
const enhanced = voice("Samantha (Enhanced)", "samantha.enhanced");
const premium = voice("Samantha", "samantha.premium");
const alex = voice("Alex", "alex");
const effect = voice("Bells", "bells", "en-US", true);
const british = voice("Daniel", "daniel", "en-GB", true);
const chinese = voice("Tingting", "tingting", "zh-CN", true);
const controllers: SpeechController[] = [];

async function setup(initialVoices = [effect, chinese, british, alex, samantha], saved?: unknown, supported = true, catalog: unknown = { available: false }, catalogResponse?: Promise<unknown>) {
  const elements = Object.fromEntries(["voiceSelect", "previewVoiceBtn", "speechRate", "speechRateValue", "speechStatus", "speakButton", "samanthaFallbackBtn", "speechHelp"]
    .map((id) => [id, new TestElement()]));
  const doc = Object.assign(new EventTarget(), {
    hidden: false,
    querySelector: (selector: string) => elements[selector.slice(1)]
  });
  const storage = new Map<string, string>();
  if (saved !== undefined) storage.set("basicTypingSpeechSettings", JSON.stringify(saved));
  const synth = Object.assign(new EventTarget(), {
    voices: initialVoices,
    calls: [] as TestUtterance[],
    active: null as TestUtterance | null,
    getVoices: () => synth.voices,
    speak: vi.fn((utterance: TestUtterance) => {
      synth.calls.push(utterance);
      synth.active = utterance;
      utterance.onstart?.();
    }),
    cancel: vi.fn(() => {
      const previous = synth.active;
      synth.active = null;
      previous?.onerror?.({ error: "canceled" });
    })
  });
  const audios: TestAudio[] = [];
  class Audio extends TestAudio { constructor() { super(); audios.push(this); } }
  const browser = Object.assign(new EventTarget(), {
    ...((catalog as { available?: boolean })?.available ? { Audio } : {}),
    setTimeout: (callback: () => void, delay: number) => setTimeout(callback, delay),
    clearTimeout: (timer: ReturnType<typeof setTimeout>) => clearTimeout(timer),
    ...(supported ? { speechSynthesis: synth, SpeechSynthesisUtterance: TestUtterance } : {})
  });
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => catalogResponse ? await catalogResponse : catalog })));
  vi.stubGlobal("window", browser);
  vi.stubGlobal("document", doc);
  vi.stubGlobal("Option", TestOption);
  vi.stubGlobal("SpeechSynthesisUtterance", TestUtterance);
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value)
  });
  const session = { active: true, auto: false, text: "apple" as string | null, itemId: "apple-id" };
  const controller = createSpeechController({
    speakButton: elements.speakButton as unknown as HTMLButtonElement,
    isActive: () => session.active,
    getText: () => session.text,
    getItem: () => session.text ? { id: session.itemId, english: session.text } : null,
    autoEnabled: () => session.auto
  });
  controllers.push(controller);
  for (let i = 0; i < 8; i++) await Promise.resolve();
  return {
    controller, session, elements, synth, storage, doc, browser, audios,
    setVoices: (voices: SpeechSynthesisVoice[]) => {
      synth.voices = voices;
      synth.dispatchEvent(new Event("voiceschanged"));
    }
  };
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => {
  controllers.splice(0).forEach((controller) => controller.destroy());
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("account practice speech", () => {
  it("only offers Samantha and never falls back to another voice", async () => {
    const env = await setup([], { ...alex, rate: 1.1 });
    expect(env.elements.speakButton.disabled).toBe(true);
    env.setVoices([samantha, alex, premium]);
    expect(env.elements.voiceSelect.options.length).toBe(1);
    env.controller.speakCurrent();
    expect(env.synth.calls.at(-1)?.voice).toEqual(premium);
    expect(env.synth.calls.at(-1)?.rate).toBe(1.1);
    const count = env.synth.calls.length;
    env.setVoices([alex, british, effect]);
    env.controller.speakCurrent();
    expect(env.synth.calls.length).toBe(count);
    expect(env.elements.speakButton.disabled).toBe(true);
    env.setVoices([samantha]);
    env.controller.speakCurrent();
    expect(env.synth.calls.at(-1)?.voice).toEqual(samantha);
  });

  it("selects Samantha quality variants while keeping a single option", async () => {
    const env = await setup([samantha, enhanced, premium]);
    env.controller.speakCurrent();
    expect(env.synth.calls.at(-1)?.voice).toEqual(premium);
    env.setVoices([samantha, enhanced, alex]);
    env.controller.speakCurrent();
    expect(env.synth.calls.at(-1)?.voice).toEqual(enhanced);
    expect(env.elements.voiceSelect.options).toHaveLength(1);
  });

  it("keeps speech working when preference storage is blocked", async () => {
    const env = await setup([samantha]);
    vi.stubGlobal("localStorage", {
      getItem: () => { throw new Error("Storage blocked"); },
      setItem: () => { throw new Error("Storage blocked"); }
    });
    env.elements.speechRate.value = "1.1";
    env.elements.speechRate.dispatchEvent(new Event("input"));
    env.controller.speakCurrent();
    expect(env.synth.calls.at(-1)?.voice).toEqual(samantha);
    expect(env.synth.calls.at(-1)?.rate).toBe(1.1);
  });

  it("uses the selected rate for words, long sentences and preview without slowing them", async () => {
    const env = await setup();
    env.elements.speechRate.value = "1.2";
    env.elements.speechRate.dispatchEvent(new Event("input"));
    env.elements.speakButton.dispatchEvent(new Event("click"));
    env.session.text = "I would like to practice ____ every day so that I can speak more naturally.";
    env.controller.speakCurrent();
    env.elements.previewVoiceBtn.dispatchEvent(new Event("click"));
    expect(env.synth.calls.map((call) => [call.rate, call.pitch])).toEqual([[1.2, 1], [1.2, 1], [1.2, 1]]);
    expect(env.synth.calls[1].text).toContain("blank");
    expect(env.synth.calls[2].text).toContain("Let's practice English");
    expect(env.elements.speechRateValue.textContent).toBe("1.20 倍");
  });

  it("cancels stale auto speech when moving quickly, disabling auto or hiding the page", async () => {
    const env = await setup();
    env.session.auto = true;
    env.controller.scheduleCurrent();
    env.session.text = "book";
    env.controller.scheduleCurrent();
    vi.advanceTimersByTime(180);
    expect(env.synth.calls.map((call) => call.text)).toEqual(["book"]);
    env.controller.scheduleCurrent();
    env.session.auto = false;
    vi.advanceTimersByTime(180);
    expect(env.synth.calls).toHaveLength(1);
    env.session.auto = true;
    env.controller.scheduleCurrent();
    env.doc.hidden = true;
    env.doc.dispatchEvent(new Event("visibilitychange"));
    vi.advanceTimersByTime(180);
    expect(env.synth.calls).toHaveLength(1);
    expect(env.synth.active).toBeNull();
  });

  it("ignores canceled utterance callbacks and reports current playback errors", async () => {
    const env = await setup();
    env.controller.speakCurrent();
    const previous = env.synth.calls[0];
    env.controller.speakCurrent();
    previous.onerror?.({ error: "network" });
    previous.onend?.();
    expect(env.elements.speechStatus.textContent).toContain("正在朗读");
    env.synth.calls[1].onerror?.({ error: "not-allowed" });
    expect(env.elements.speechStatus.textContent).toContain("请先点击");
    expect(env.elements.speechStatus.className).toContain("bad");
    env.synth.speak.mockImplementationOnce(() => { throw new Error("synthesis failure"); });
    env.controller.speakCurrent();
    expect(env.elements.speechStatus.textContent).toContain("朗读失败");
  });

  it("cleans up pending playback and every event listener when leaving practice", async () => {
    const env = await setup();
    env.session.auto = true;
    env.controller.scheduleCurrent();
    env.controller.destroy();
    const cancels = env.synth.cancel.mock.calls.length;
    const status = env.elements.speechStatus.textContent;
    env.setVoices([premium]);
    env.elements.speakButton.dispatchEvent(new Event("click"));
    env.elements.previewVoiceBtn.dispatchEvent(new Event("click"));
    env.elements.speechRate.dispatchEvent(new Event("input"));
    env.elements.voiceSelect.dispatchEvent(new Event("change"));
    env.browser.dispatchEvent(new Event("pagehide"));
    env.controller.stop();
    env.controller.refresh();
    env.controller.speakCurrent();
    vi.advanceTimersByTime(1000);
    expect(env.synth.calls).toHaveLength(0);
    expect(env.synth.cancel).toHaveBeenCalledTimes(cancels);
    expect(env.elements.speechStatus.textContent).toBe(status);
  });

  it("leaves practice usable without speech support and clamps invalid saved rates", async () => {
    const env = await setup([], { rate: 9 }, false);
    expect(env.controller.supported).toBe(false);
    expect(env.elements.speakButton.disabled).toBe(true);
    expect(env.elements.previewVoiceBtn.disabled).toBe(true);
    expect(env.elements.speechRate.disabled).toBe(true);
    expect(env.elements.speechRateValue.textContent).toBe("1.25 倍");
    expect(env.elements.speechStatus.textContent).toContain("仍可继续打字练习");
    env.controller.speakCurrent();
    expect(env.synth.calls).toHaveLength(0);
  });
});

describe("recorded practice speech", () => {
  it("defaults to five voices and restores only a valid saved voice and rate", async () => {
    const env = await setup([], undefined, false, catalog);
    expect(env.elements.voiceSelect.options.map(o => o.value)).toEqual(["01", "02", "03", "04", "05"]);
    expect(env.elements.voiceSelect.value).toBe("01");
    expect(env.controller.supported).toBe(true);
    env.controller.speakCurrent();
    expect(env.audios[0].calls[0]).toEqual({ src: `/api/speech/audio/01/${"a".repeat(64)}?itemId=apple-id`, rate: 1, preservesPitch: true });
    expect(env.synth.calls).toHaveLength(0);
    const restored = await setup([], { voiceId: "05", rate: 1.15 }, false, catalog);
    expect(restored.elements.voiceSelect.value).toBe("05");
    restored.elements.previewVoiceBtn.dispatchEvent(new Event("click"));
    expect(restored.audios[0].calls[0]).toEqual({ src: "/api/speech/preview/05", rate: 1.15, preservesPitch: true });
  });

  it("switches and saves voice without changing input and stops before changing rate", async () => {
    const env = await setup([samantha], undefined, true, catalog);
    const player = env.audios[0];
    env.controller.speakCurrent();
    env.elements.voiceSelect.value = "03";
    env.elements.voiceSelect.dispatchEvent(new Event("change"));
    expect(player.paused).toBe(true);
    expect(player.src).toBe("");
    env.elements.speechRate.value = "0.85";
    env.elements.speechRate.dispatchEvent(new Event("input"));
    expect(JSON.parse(env.storage.get("basicTypingSpeechSettings")!)).toEqual({ voiceId: "03", rate: 0.85 });
    env.controller.speakCurrent();
    expect(player.calls.at(-1)).toMatchObject({ rate: 0.85, preservesPitch: true });
    expect(player.calls.at(-1)?.src).toContain("/03/");
    expect(env.session.text).toBe("apple");
    expect(env.audios).toHaveLength(1);
  });

  it("does not silently use Samantha for missing, changed or private items", async () => {
    const env = await setup([samantha], undefined, true, catalog);
    for (const [itemId, text] of [["new", "new sentence"], ["apple-id", "changed"], ["private", "apple"]]) {
      env.session.itemId = itemId;
      env.session.text = text;
      env.controller.refresh();
      env.controller.speakCurrent();
      expect(env.elements.speakButton.disabled).toBe(true);
      expect(env.elements.samanthaFallbackBtn.hidden).toBe(false);
      expect(env.elements.speechStatus.textContent).toContain("暂未生成");
    }
    expect(env.audios[0].calls).toHaveLength(0);
    expect(env.synth.calls).toHaveLength(0);
    env.elements.samanthaFallbackBtn.dispatchEvent(new Event("click"));
    expect(env.synth.calls.at(-1)?.text).toBe("apple");
    expect(env.elements.speechStatus.textContent).toContain("系统 Samantha");
    expect(env.elements.voiceSelect.value).toBe("01");
  });

  it("cancels queued audio, old callbacks and play rejection across repeated clicks and navigation", async () => {
    const env = await setup([samantha], undefined, true, catalog);
    const player = env.audios[0];
    let reject!: (error: Error) => void;
    player.play.mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; }));
    env.controller.speakCurrent();
    const oldError = player.onerror;
    const oldEnd = player.onended;
    env.session.itemId = "book-id";
    env.session.text = "book";
    env.session.auto = true;
    env.controller.scheduleCurrent();
    vi.advanceTimersByTime(180);
    reject(new Error("old failure"));
    await Promise.resolve();
    oldError?.(); oldEnd?.();
    expect(env.elements.speechStatus.textContent).toContain("正在朗读");
    expect(player.src).toContain("b".repeat(64));
    env.controller.scheduleCurrent();
    env.session.auto = false;
    vi.advanceTimersByTime(180);
    expect(player.paused).toBe(true);
    env.session.auto = true;
    env.controller.scheduleCurrent();
    env.doc.hidden = true;
    env.doc.dispatchEvent(new Event("visibilitychange"));
    vi.advanceTimersByTime(180);
    expect(player.src).toBe("");
    expect(player.calls).toHaveLength(1);
  });

  it("reports media and autoplay failures with an explicit system fallback", async () => {
    const env = await setup([samantha], undefined, true, catalog);
    const player = env.audios[0];
    env.controller.speakCurrent();
    player.onerror?.();
    expect(env.elements.speechStatus.className).toContain("bad");
    expect(env.elements.samanthaFallbackBtn.hidden).toBe(false);
    expect(env.synth.calls).toHaveLength(0);
    player.play.mockRejectedValueOnce(Object.assign(new Error("blocked"), { name: "NotAllowedError" }));
    env.controller.speakCurrent();
    await Promise.resolve();
    expect(env.elements.speechStatus.textContent).toContain("请先点击");
    env.controller.destroy();
    expect(player.src).toBe("");
    expect(player.paused).toBe(true);
    const count = player.calls.length;
    env.elements.voiceSelect.dispatchEvent(new Event("change"));
    env.elements.previewVoiceBtn.dispatchEvent(new Event("click"));
    expect(player.calls).toHaveLength(count);
  });

  it("rejects malformed catalog URLs and preserves Samantha fallback", async () => {
    const malformed = structuredClone(catalog);
    malformed.voices[0].previewUrl = "https://example.com/audio.wav";
    const env = await setup([samantha], { voiceId: "09", rate: NaN }, true, malformed);
    expect(env.elements.voiceSelect.options).toHaveLength(1);
    env.controller.speakCurrent();
    expect(env.synth.calls.at(-1)?.voice).toEqual(samantha);
    expect(env.synth.calls.at(-1)?.rate).toBe(1);
  });
});

describe("speech resource lifecycle", () => {
  it("applies delayed catalog without replaying a stale item or resetting a changed rate", async () => {
    let resolve!: (value: unknown) => void;
    const pending = new Promise<unknown>(done => { resolve = done; });
    const env = await setup([samantha], undefined, true, catalog, pending);
    expect(env.elements.speakButton.disabled).toBe(true);
    env.session.auto = true;
    env.controller.scheduleCurrent();
    env.session.text = "book";
    env.session.itemId = "book-id";
    env.elements.speechRate.value = "0.8";
    env.elements.speechRate.dispatchEvent(new Event("input"));
    resolve(catalog);
    for (let i = 0; i < 10; i++) await Promise.resolve();
    vi.advanceTimersByTime(180);
    expect(env.audios[0].calls).toHaveLength(1);
    expect(env.audios[0].calls[0]).toMatchObject({ rate: 0.8 });
    expect(env.audios[0].calls[0].src).toContain("book-id");
    expect(env.synth.calls).toHaveLength(0);
  });

  it("ignores a late catalog response after disposing practice", async () => {
    let resolve!: (value: unknown) => void;
    const pending = new Promise<unknown>(done => { resolve = done; });
    const env = await setup([samantha], undefined, true, catalog, pending);
    env.session.auto = true;
    env.controller.destroy();
    const status = env.elements.speechStatus.textContent;
    resolve(catalog);
    for (let i = 0; i < 10; i++) await Promise.resolve();
    vi.advanceTimersByTime(1000);
    expect(env.elements.speechStatus.textContent).toBe(status);
    expect(env.audios[0].calls).toHaveLength(0);
    expect(env.synth.calls).toHaveLength(0);
  });

  it("honors per-voice coverage and works with blocked preference storage", async () => {
    const partial = structuredClone(catalog);
    partial.entries[0].voiceIds = ["01"];
    const env = await setup([samantha], undefined, true, partial);
    vi.stubGlobal("localStorage", { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } });
    env.elements.voiceSelect.value = "05";
    env.elements.voiceSelect.dispatchEvent(new Event("change"));
    expect(env.elements.speakButton.disabled).toBe(true);
    env.elements.previewVoiceBtn.dispatchEvent(new Event("click"));
    expect(env.audios[0].calls.at(-1)?.src).toBe("/api/speech/preview/05");
    env.elements.voiceSelect.value = "01";
    env.elements.voiceSelect.dispatchEvent(new Event("change"));
    expect(env.elements.speakButton.disabled).toBe(false);
  });

  it("refreshes changed item coverage without resetting selection or rate and deduplicates requests", async () => {
    const env = await setup([], { voiceId: "05", rate: 1.15 }, false, catalog);
    env.session.text = "book";
    env.session.auto = true;
    env.controller.refresh();
    expect(env.elements.speakButton.disabled).toBe(true);
    let resolve!: (value: unknown) => void;
    const deferred = new Promise<unknown>(done => { resolve = done; });
    vi.mocked(fetch).mockResolvedValueOnce({ ok: true, json: async () => deferred } as Response);
    const task = env.controller.reloadCatalog({ invalidate: true });
    expect(env.controller.reloadCatalog()).toBe(task);
    expect(env.elements.voiceSelect.value).toBe("05");
    env.elements.voiceSelect.value = "03";
    env.elements.voiceSelect.dispatchEvent(new Event("change"));
    env.elements.speechRate.value = "0.85";
    env.elements.speechRate.dispatchEvent(new Event("input"));
    const updated = structuredClone(catalog);
    updated.entries[0] = { ...updated.entries[1], itemId: "apple-id" };
    resolve(updated);
    await task;
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(env.elements.speakButton.disabled).toBe(false);
    expect(env.elements.voiceSelect.value).toBe("03");
    expect(env.elements.speechRate.value).toBe("0.85");
    expect(env.session.text).toBe("book");
    vi.advanceTimersByTime(180);
    expect(env.audios[0].calls).toHaveLength(0);
    env.controller.scheduleCurrent();
    vi.advanceTimersByTime(180);
    expect(env.audios[0].calls).toEqual([{
      src: `/api/speech/audio/03/${"b".repeat(64)}?itemId=apple-id`, rate: 0.85, preservesPitch: true
    }]);
  });

  it("recovers a failed initial catalog on online without replaying or changing saved preferences", async () => {
    const env = await setup([], { voiceId: "05", rate: 1.2 }, false, catalog, Promise.reject(new Error("offline")));
    expect(env.elements.voiceSelect.options).toHaveLength(1);
    env.session.auto = true;
    let resolve!: (value: unknown) => void;
    const pending = new Promise<unknown>(done => { resolve = done; });
    vi.mocked(fetch).mockResolvedValueOnce({ ok: true, json: async () => pending } as Response);
    env.browser.dispatchEvent(new Event("online"));
    env.browser.dispatchEvent(new Event("online"));
    const loaded = env.controller.reloadCatalog();
    expect(fetch).toHaveBeenCalledTimes(2);
    resolve(catalog);
    await loaded;
    expect(env.elements.voiceSelect.options).toHaveLength(5);
    expect(env.elements.voiceSelect.value).toBe("05");
    expect(env.elements.speechRate.value).toBe("1.2");
    vi.advanceTimersByTime(180);
    expect(env.audios[0].calls).toHaveLength(0);
    env.controller.speakCurrent();
    const playingSrc = env.audios[0].src;
    await env.controller.reloadCatalog();
    expect(env.audios[0].src).toBe(playingSrc);
    expect(env.audios[0].paused).toBe(false);
    expect(env.audios[0].calls).toHaveLength(1);
  });

  it("ignores superseded responses and aborts a reload when practice is disposed", async () => {
    let resolveOld!: (value: unknown) => void;
    const old = new Promise<unknown>(done => { resolveOld = done; });
    const env = await setup([], undefined, false, catalog, old);
    const initialSignal = vi.mocked(fetch).mock.calls[0][1]!.signal!;
    vi.mocked(fetch).mockResolvedValueOnce({ ok: true, json: async () => catalog } as Response);
    await env.controller.reloadCatalog({ invalidate: true });
    expect(initialSignal.aborted).toBe(true);
    expect(env.elements.voiceSelect.options).toHaveLength(5);
    resolveOld({ available: false });
    for (let i = 0; i < 12; i++) await Promise.resolve();
    expect(env.elements.voiceSelect.options).toHaveLength(5);
    let resolveLate!: (value: unknown) => void;
    const late = new Promise<unknown>(done => { resolveLate = done; });
    vi.mocked(fetch).mockResolvedValueOnce({ ok: true, json: async () => late } as Response);
    const pending = env.controller.reloadCatalog();
    const signal = vi.mocked(fetch).mock.calls.at(-1)![1]!.signal!;
    env.controller.destroy();
    const message = env.elements.speechStatus.textContent;
    expect(signal.aborted).toBe(true);
    resolveLate({ available: false });
    await pending;
    env.browser.dispatchEvent(new Event("online"));
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(env.elements.speechStatus.textContent).toBe(message);
    expect(env.audios[0].calls).toHaveLength(0);
  });
});

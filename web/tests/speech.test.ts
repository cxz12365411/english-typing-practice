import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSpeechController, type SpeechController } from "../src/speech";

class TestOption {
  disabled = false;
  constructor(public text: string, public value: string) {}
}

class TestElement extends EventTarget {
  disabled = false;
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

function setup(initialVoices = [effect, chinese, british, alex, samantha], saved?: unknown, supported = true) {
  const elements = Object.fromEntries(["voiceSelect", "previewVoiceBtn", "speechRate", "speechRateValue", "speechStatus", "speakButton"]
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
  const browser = Object.assign(new EventTarget(), {
    setTimeout: (callback: () => void, delay: number) => setTimeout(callback, delay),
    clearTimeout: (timer: ReturnType<typeof setTimeout>) => clearTimeout(timer),
    ...(supported ? { speechSynthesis: synth, SpeechSynthesisUtterance: TestUtterance } : {})
  });
  vi.stubGlobal("window", browser);
  vi.stubGlobal("document", doc);
  vi.stubGlobal("Option", TestOption);
  vi.stubGlobal("SpeechSynthesisUtterance", TestUtterance);
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value)
  });
  const session = { active: true, auto: false, text: "apple" as string | null };
  const controller = createSpeechController({
    speakButton: elements.speakButton as unknown as HTMLButtonElement,
    isActive: () => session.active,
    getText: () => session.text,
    autoEnabled: () => session.auto
  });
  controllers.push(controller);
  return {
    controller, session, elements, synth, storage, doc, browser,
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
  it("prefers Samantha quality variants and falls back to ordinary US voices", () => {
    const env = setup();
    env.controller.speakCurrent();
    expect(env.synth.calls.at(-1)?.voice).toEqual(samantha);
    env.setVoices([enhanced, premium, samantha]);
    env.controller.speakCurrent();
    expect(env.synth.calls.at(-1)?.voice).toEqual(premium);
    env.setVoices([samantha, enhanced]);
    env.controller.speakCurrent();
    expect(env.synth.calls.at(-1)?.voice).toEqual(enhanced);
    env.setVoices([chinese, effect, british, alex]);
    env.controller.speakCurrent();
    expect(env.synth.calls.at(-1)?.voice).toEqual(alex);
    expect(env.elements.voiceSelect.options.some((option) => option.value === chinese.voiceURI)).toBe(false);
    env.setVoices([effect]);
    expect(env.elements.speakButton.disabled).toBe(true);
  });

  it("keeps an unavailable saved choice and restores it after delayed voice loading", () => {
    const env = setup([], { ...alex, rate: 1.1 });
    expect(env.elements.voiceSelect.value).toBe("alex");
    expect(env.elements.voiceSelect.selectedOptions[0]?.disabled).toBe(true);
    env.setVoices([samantha]);
    expect(env.elements.speechStatus.textContent).toContain("已保存的音色暂不可用");
    env.controller.speakCurrent();
    expect(env.synth.calls.at(-1)?.voice).toEqual(samantha);
    env.setVoices([samantha, alex]);
    env.controller.speakCurrent();
    expect(env.synth.calls.at(-1)?.voice).toEqual(alex);
    expect(env.synth.calls.at(-1)?.rate).toBe(1.1);
  });

  it("preserves a manual choice through voiceschanged and stores changes locally", () => {
    const env = setup();
    env.elements.voiceSelect.value = alex.voiceURI;
    env.elements.voiceSelect.dispatchEvent(new Event("change"));
    env.setVoices([premium, alex]);
    expect(env.elements.voiceSelect.value).toBe(alex.voiceURI);
    env.controller.speakCurrent();
    expect(env.synth.calls.at(-1)?.voice).toEqual(alex);
    expect(JSON.parse(env.storage.get("basicTypingSpeechSettings") || "{}")).toMatchObject({ voiceURI: "alex", rate: 1 });
  });

  it("uses the selected rate for words, long sentences and preview without slowing them", () => {
    const env = setup();
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

  it("cancels stale auto speech when moving quickly, disabling auto or hiding the page", () => {
    const env = setup();
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

  it("ignores canceled utterance callbacks and reports current playback errors", () => {
    const env = setup();
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

  it("cleans up pending playback and every event listener when leaving practice", () => {
    const env = setup();
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

  it("leaves practice usable without speech support and clamps invalid saved rates", () => {
    const env = setup([], { rate: 9 }, false);
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

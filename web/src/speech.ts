const settingsKey = "basicTypingSpeechSettings";

interface SpeechControllerOptions {
  speakButton: HTMLButtonElement;
  isActive: () => boolean;
  getText: () => string | null;
  autoEnabled: () => boolean;
}

export interface SpeechController {
  readonly supported: boolean;
  speakCurrent(): void;
  stop(): void;
  scheduleCurrent(): void;
  refresh(): void;
  destroy(): void;
}

export function speechSettingsMarkup(): string {
  return `
    <details class="speech-settings" open>
      <summary>朗读设置</summary>
      <div class="speech-options">
        <div class="control">
          <label for="voiceSelect">英语音色</label>
          <select id="voiceSelect"><option value="">自动推荐 · Samantha</option></select>
        </div>
        <div class="control">
          <label for="speechRate">语速 <output id="speechRateValue" for="speechRate">1.00 倍</output></label>
          <input id="speechRate" type="range" min="0.75" max="1.25" step="0.05" value="1">
        </div>
        <button class="btn" id="previewVoiceBtn" type="button">试听声音</button>
      </div>
      <p class="speech-status" id="speechStatus" role="status" aria-live="polite"></p>
      <p class="muted speech-help">仅使用系统 Samantha 声音，语速会保存在本机。</p>
    </details>
  `;
}

function normaliseRate(value: number): number {
  return Number.isFinite(value) ? Math.round(Math.min(1.25, Math.max(0.75, value)) * 20) / 20 : 1;
}

function loadSettings(): { rate: number } {
  try {
    const saved = JSON.parse(localStorage.getItem(settingsKey) || "null");
    return {
      rate: typeof saved?.rate === "number" ? normaliseRate(saved.rate) : 1
    };
  } catch {
    return { rate: 1 };
  }
}

// Only Samantha is eligible. Prefer its premium/enhanced system variants.
function voiceRank(voice: SpeechSynthesisVoice): number {
  const identity = `${voice.name} ${voice.voiceURI}`;
  const localeRank = /^en[-_]US$/i.test(voice.lang) ? 0 : 3;
  return localeRank + (/premium/i.test(identity) ? 0 : /enhanced/i.test(identity) ? 1 : 2);
}

export function createSpeechController(options: SpeechControllerOptions): SpeechController {
  function element<T extends HTMLElement>(selector: string): T {
    const found = document.querySelector<T>(selector);
    if (!found) throw new Error(`Missing speech setting: ${selector}`);
    return found;
  }

  const voiceSelect = element<HTMLSelectElement>("#voiceSelect");
  const previewButton = element<HTMLButtonElement>("#previewVoiceBtn");
  const rateInput = element<HTMLInputElement>("#speechRate");
  const rateValue = element<HTMLOutputElement>("#speechRateValue");
  const status = element<HTMLElement>("#speechStatus");
  const supported = "speechSynthesis" in window && "SpeechSynthesisUtterance" in window;
  const synth = supported ? window.speechSynthesis : null;
  const saved = loadSettings();
  let rate = saved.rate;
  let voices: SpeechSynthesisVoice[] = [];
  let voice: SpeechSynthesisVoice | null = null;
  let utterance: SpeechSynthesisUtterance | null = null;
  let request = 0;
  let autoTimer: number | null = null;
  let destroyed = false;

  function active(): boolean { return !destroyed && options.isActive(); }

  function setStatus(message: string, error = false): void {
    status.textContent = message;
    status.className = `speech-status${error ? " bad" : ""}`;
  }

  function idleStatus(): string {
    if (!supported) return "当前浏览器不支持朗读，仍可继续打字练习。";
    if (!voice) return "当前设备未提供 Samantha，请安装或启用该系统声音后重新打开页面。";
    return `当前音色：${voice.name}（${voice.lang}）`;
  }

  function save(): void {
    try {
      localStorage.setItem(settingsKey, JSON.stringify({
        rate
      }));
    } catch {
      // Blocked storage must not prevent speech for this visit.
    }
  }

  function refresh(): void {
    if (destroyed) return;
    voices = synth ? synth.getVoices().filter((entry) => /^en(?:[-_]|$)/i.test(entry.lang) && /\bSamantha\b/i.test(entry.name))
      .sort((a, b) => voiceRank(a) - voiceRank(b) || a.name.localeCompare(b.name)) : [];
    voice = voices[0] || null;
    voiceSelect.replaceChildren(new Option(voice ? `自动推荐 · ${voice.name}` : "Samantha · 当前设备不可用", ""));
    voiceSelect.value = "";
    options.speakButton.disabled = !voice || !options.getText();
    previewButton.disabled = !voice;
    voiceSelect.disabled = !supported || !voices.length;
    rateInput.disabled = !supported;
    if (!utterance) setStatus(idleStatus());
  }

  function stop(): void {
    if (destroyed) return;
    if (autoTimer !== null) window.clearTimeout(autoTimer);
    autoTimer = null;
    request += 1;
    utterance = null;
    synth?.cancel();
    if (!destroyed) setStatus(idleStatus());
  }

  function speakText(text: string): void {
    if (!active()) return;
    stop();
    refresh();
    if (!voice || !text || !synth) return;
    const speechRequest = request;
    const speakingVoice = voice;
    const current = new SpeechSynthesisUtterance(text.replace(/____/g, "blank"));
    current.lang = speakingVoice.lang;
    current.rate = rate;
    current.pitch = 1;
    current.voice = speakingVoice;
    utterance = current;
    current.onstart = () => {
      if (active() && speechRequest === request) setStatus(`正在朗读 · ${speakingVoice.name}`);
    };
    current.onend = () => {
      if (!active() || speechRequest !== request) return;
      utterance = null;
      setStatus(idleStatus());
    };
    current.onerror = (event) => {
      if (!active() || speechRequest !== request) return;
      utterance = null;
      if (event.error === "canceled" || event.error === "interrupted") {
        setStatus(idleStatus());
        return;
      }
      setStatus(event.error === "not-allowed"
        ? "请先点击“朗读”或“试听声音”，再使用自动朗读。"
        : "朗读失败，请重试或检查系统 Samantha 声音。", true);
    };
    try {
      synth.speak(current);
    } catch {
      if (!active() || speechRequest !== request) return;
      utterance = null;
      setStatus("朗读失败，请重试或检查系统 Samantha 声音。", true);
    }
  }

  function speakCurrent(): void {
    if (!active()) return;
    const text = options.getText();
    if (text) speakText(text);
    else stop();
  }

  function scheduleCurrent(): void {
    if (!active()) return;
    stop();
    const text = options.getText();
    if (!text || !options.autoEnabled() || document.hidden) return;
    const speechRequest = request;
    autoTimer = window.setTimeout(() => {
      autoTimer = null;
      if (active() && options.autoEnabled() && !document.hidden && request === speechRequest && options.getText() === text) {
        speakCurrent();
      }
    }, 180);
  }

  const preview = (): void => speakText("Hello! Let's practice English together.");
  const changeRate = (): void => {
    if (!active()) return;
    stop();
    rate = normaliseRate(Number(rateInput.value));
    rateInput.value = String(rate);
    rateValue.textContent = `${rate.toFixed(2)} 倍`;
    save();
  };
  const onVisibilityChange = (): void => { if (document.hidden) stop(); };
  const onRefresh = (): void => { if (active()) refresh(); };

  function destroy(): void {
    if (destroyed) return;
    stop();
    destroyed = true;
    options.speakButton.removeEventListener("click", speakCurrent);
    previewButton.removeEventListener("click", preview);
    rateInput.removeEventListener("input", changeRate);
    synth?.removeEventListener("voiceschanged", onRefresh);
    window.removeEventListener("pagehide", stop);
    window.removeEventListener("pageshow", onRefresh);
    document.removeEventListener("visibilitychange", onVisibilityChange);
  }

  rateInput.value = String(rate);
  rateValue.textContent = `${rate.toFixed(2)} 倍`;
  options.speakButton.addEventListener("click", speakCurrent);
  previewButton.addEventListener("click", preview);
  rateInput.addEventListener("input", changeRate);
  synth?.addEventListener("voiceschanged", onRefresh);
  window.addEventListener("pagehide", stop);
  window.addEventListener("pageshow", onRefresh);
  document.addEventListener("visibilitychange", onVisibilityChange);
  refresh();
  return { supported, speakCurrent, stop, scheduleCurrent, refresh, destroy };
}

const settingsKey = "basicTypingSpeechSettings";
const voiceIds = ["01", "02", "03", "04", "05"];

interface SpeechItem { id: string; english: string }
interface SpeechControllerOptions {
  speakButton: HTMLButtonElement;
  isActive: () => boolean;
  getText: () => string | null;
  getItem?: () => SpeechItem | null;
  autoEnabled: () => boolean;
}
interface RecordedVoice { id: string; name: string; previewUrl: string | null }
interface RecordedEntry { itemId: string; english: string; textKey: string; voiceIds: string[] }
interface SpeechCatalog { voices: RecordedVoice[]; entries: RecordedEntry[] }

export interface SpeechController {
  readonly supported: boolean;
  speakCurrent(): void;
  stop(): void;
  scheduleCurrent(): void;
  refresh(): void;
  reloadCatalog(options?: { invalidate?: boolean }): Promise<void>;
  destroy(): void;
}

export function speechSettingsMarkup(): string {
  return `
    <details class="speech-settings" open>
      <summary>朗读设置</summary>
      <div class="speech-options">
        <div class="control">
          <label for="voiceSelect">英语音色</label>
          <select id="voiceSelect"><option value="">正在加载声音…</option></select>
        </div>
        <div class="control">
          <label for="speechRate">语速 <output id="speechRateValue" for="speechRate">1.00 倍</output></label>
          <input id="speechRate" type="range" min="0.75" max="1.25" step="0.05" value="1">
        </div>
        <button class="btn" id="previewVoiceBtn" type="button">试听声音</button>
      </div>
      <p class="speech-status" id="speechStatus" role="status" aria-live="polite"></p>
      <button class="btn small" id="samanthaFallbackBtn" type="button" hidden>改用系统 Samantha 朗读此题</button>
      <p class="muted speech-help" id="speechHelp">声音和语速保存在本机。</p>
    </details>
  `;
}

function normaliseRate(value: number): number {
  return Number.isFinite(value) ? Math.round(Math.min(1.25, Math.max(0.75, value)) * 20) / 20 : 1;
}

function loadSettings(): { rate: number; voiceId: string } {
  try {
    const saved = JSON.parse(localStorage.getItem(settingsKey) || "null");
    return {
      rate: typeof saved?.rate === "number" ? normaliseRate(saved.rate) : 1,
      voiceId: voiceIds.includes(saved?.voiceId) ? saved.voiceId : "01"
    };
  } catch { return { rate: 1, voiceId: "01" }; }
}

function voiceRank(voice: SpeechSynthesisVoice): number {
  const identity = `${voice.name} ${voice.voiceURI}`;
  const localeRank = /^en[-_]US$/i.test(voice.lang) ? 0 : 3;
  return localeRank + (/premium/i.test(identity) ? 0 : /enhanced/i.test(identity) ? 1 : 2);
}

// Reject incomplete or untrusted catalogs before enabling recorded playback.
function parseCatalog(value: unknown): SpeechCatalog | null {
  const data = value as { available?: unknown; voices?: RecordedVoice[]; entries?: RecordedEntry[] } | null;
  if (data?.available !== true || !Array.isArray(data.voices) || !Array.isArray(data.entries)) return null;
  if (data.voices.length !== voiceIds.length || !voiceIds.every(id => data.voices!.filter(v => v?.id === id).length === 1)) return null;
  if (data.voices.some(v => typeof v.name !== "string" || !v.name || (v.previewUrl !== null && v.previewUrl !== `/api/speech/preview/${v.id}`))) return null;
  if (data.entries.some(e => !e || typeof e.itemId !== "string" || typeof e.english !== "string"
    || typeof e.textKey !== "string" || !/^[a-f0-9]{64}$/.test(e.textKey) || !Array.isArray(e.voiceIds) || e.voiceIds.some(id => !voiceIds.includes(id)))) return null;
  return { voices: [...data.voices].sort((a, b) => a.id.localeCompare(b.id)), entries: data.entries };
}

export function createSpeechController(options: SpeechControllerOptions): SpeechController {
  function element<T extends HTMLElement>(selector: string): T {
    const found = document.querySelector<T>(selector);
    if (!found) throw new Error(`Missing speech setting: ${selector}`);
    return found;
  }
  const voiceSelect = element<HTMLSelectElement>("#voiceSelect");
  const previewButton = element<HTMLButtonElement>("#previewVoiceBtn");
  const fallbackButton = element<HTMLButtonElement>("#samanthaFallbackBtn");
  const help = element<HTMLElement>("#speechHelp");
  const rateInput = element<HTMLInputElement>("#speechRate");
  const rateValue = element<HTMLOutputElement>("#speechRateValue");
  const status = element<HTMLElement>("#speechStatus");
  const synth = "speechSynthesis" in window && "SpeechSynthesisUtterance" in window ? window.speechSynthesis : null;
  const audio = typeof window.Audio === "function" ? new window.Audio() : null;
  if (audio) { audio.preload = "none"; audio.preservesPitch = true; }
  const saved = loadSettings();
  let rate = saved.rate;
  let voiceId = saved.voiceId;
  let samantha: SpeechSynthesisVoice | null = null;
  let utterance: SpeechSynthesisUtterance | null = null;
  let catalog: SpeechCatalog | null = null;
  let loading = true;
  let failedAudio = false;
  let playingAudio = false;
  let request = 0;
  let autoTimer: number | null = null;
  let destroyed = false;
  let renderedOptions = "";
  let catalogAbort: AbortController | null = null;
  let catalogTimeout: number | null = null;
  let catalogTask: Promise<void> | null = null;
  let catalogSequence = 0;
  const supported = Boolean(audio || synth);

  function active(): boolean { return !destroyed && options.isActive(); }
  function recordedVoice(): RecordedVoice | undefined { return catalog?.voices.find(v => v.id === voiceId); }
  function currentEntry(): RecordedEntry | undefined {
    const item = options.getItem?.();
    return item ? catalog?.entries.find(entry => entry.itemId === item.id && entry.english === item.english && entry.voiceIds.includes(voiceId)) : undefined;
  }
  function setStatus(message: string, error = false): void {
    status.textContent = message;
    status.className = `speech-status${error ? " bad" : ""}`;
  }
  function idleStatus(): string {
    if (loading) return "正在加载声音…";
    if (catalog && audio) return currentEntry()
      ? `当前音色：${voiceId} · ${recordedVoice()?.name}`
      : "此题暂未生成所选声音，可继续练习，或单独使用系统 Samantha 朗读。";
    if (!synth) return "当前浏览器不支持系统朗读，仍可继续打字练习。";
    if (!samantha) return "录音资源暂不可用；当前设备也未提供 Samantha，仍可继续打字练习。";
    return `录音资源暂不可用，当前使用系统 ${samantha.name}（${samantha.lang}）`;
  }
  function save(): void {
    try { localStorage.setItem(settingsKey, JSON.stringify({ rate, voiceId })); }
    catch { /* Storage is optional. */ }
  }
  function refresh(): void {
    if (destroyed) return;
    samantha = synth?.getVoices().filter(v => /^en(?:[-_]|$)/i.test(v.lang) && /\bSamantha\b/i.test(v.name))
      .sort((a, b) => voiceRank(a) - voiceRank(b) || a.name.localeCompare(b.name))[0] || null;
    const entries = loading ? [["", "正在加载声音…"]] : catalog && audio
      ? catalog.voices.map(v => [v.id, `${v.id} · ${v.name}`])
      : [["", samantha ? `自动推荐 · ${samantha.name}` : "Samantha · 当前设备不可用"]];
    const identity = JSON.stringify(entries);
    if (identity !== renderedOptions) {
      voiceSelect.replaceChildren(...entries.map(([value, label]) => new Option(label, value)));
      renderedOptions = identity;
    }
    voiceSelect.value = catalog && audio && !loading ? voiceId : "";
    voiceSelect.disabled = loading || !(catalog && audio);
    rateInput.disabled = !supported;
    options.speakButton.disabled = !active() || loading || !options.getText() || (catalog && audio ? !currentEntry() : !samantha);
    previewButton.disabled = !active() || loading || (catalog && audio ? !recordedVoice()?.previewUrl : !samantha);
    fallbackButton.hidden = !catalog || !audio || (!failedAudio && Boolean(currentEntry()));
    fallbackButton.disabled = !active() || !samantha || !options.getText();
    help.textContent = catalog && audio
      ? "五种录音声音；缺少对应录音时不会自动换声。声音和语速保存在本机。"
      : "录音资源恢复前使用系统 Samantha；不切换为其他系统声音。";
    if (!utterance && !playingAudio && !failedAudio) setStatus(idleStatus());
  }
  function clearAudio(): void {
    if (!audio) return;
    audio.onplaying = audio.onended = audio.onerror = null;
    audio.pause();
    audio.removeAttribute("src");
    audio.load();
    playingAudio = false;
  }
  function stop(): void {
    if (destroyed) return;
    if (autoTimer !== null) window.clearTimeout(autoTimer);
    autoTimer = null;
    request += 1;
    utterance = null;
    clearAudio();
    synth?.cancel();
    failedAudio = false;
    refresh();
  }
  function audioFailure(token: number, message: string): void {
    if (!active() || token !== request) return;
    clearAudio();
    failedAudio = true;
    refresh();
    setStatus(message, true);
  }
  function playRecorded(url: string): void {
    if (!active() || !audio) return;
    stop();
    const token = request;
    const selected = recordedVoice();
    audio.src = url;
    audio.playbackRate = rate;
    audio.preservesPitch = true;
    playingAudio = true;
    setStatus(`正在加载 · ${selected?.name}`);
    audio.onplaying = () => {
      if (active() && token === request) setStatus(`正在朗读 · ${selected?.name}`);
    };
    audio.onended = () => {
      if (!active() || token !== request) return;
      clearAudio();
      refresh();
    };
    audio.onerror = () => audioFailure(token, "此题录音暂时无法播放，请重试；也可单独使用系统 Samantha 朗读。");
    try {
      void audio.play().catch(error => audioFailure(token, error?.name === "NotAllowedError"
        ? "请先点击“朗读”或“试听声音”，再使用自动朗读。"
        : "录音播放失败，请重试；也可单独使用系统 Samantha 朗读。"));
    } catch { audioFailure(token, "录音播放失败，请重试；也可单独使用系统 Samantha 朗读。"); }
  }
  function speakSystem(text: string): void {
    if (!active()) return;
    stop();
    if (!samantha || !text || !synth) return;
    const token = request;
    const selected = samantha;
    const current = new SpeechSynthesisUtterance(text.replace(/____/g, "blank"));
    current.lang = selected.lang;
    current.rate = rate;
    current.pitch = 1;
    current.voice = selected;
    utterance = current;
    current.onstart = () => { if (active() && token === request) setStatus(`正在朗读 · 系统 ${selected.name}`); };
    current.onend = () => { if (active() && token === request) { utterance = null; refresh(); } };
    current.onerror = event => {
      if (!active() || token !== request) return;
      utterance = null;
      if (event.error === "canceled" || event.error === "interrupted") { refresh(); return; }
      setStatus(event.error === "not-allowed" ? "请先点击“朗读”或“试听声音”，再使用自动朗读。" : "朗读失败，请重试或检查系统 Samantha 声音。", true);
    };
    try { synth.speak(current); }
    catch { if (active() && token === request) { utterance = null; setStatus("朗读失败，请重试或检查系统 Samantha 声音。", true); } }
  }
  function speakCurrent(): void {
    if (!active()) return;
    const text = options.getText();
    if (loading || !text) { stop(); return; }
    if (catalog && audio) {
      const entry = currentEntry();
      if (!entry) { stop(); return; }
      playRecorded(`/api/speech/audio/${voiceId}/${entry.textKey}?itemId=${encodeURIComponent(entry.itemId)}`);
    } else speakSystem(text);
  }
  function scheduleCurrent(): void {
    if (!active()) return;
    stop();
    const text = options.getText();
    const itemId = options.getItem?.()?.id;
    if (!text || !options.autoEnabled() || document.hidden) return;
    const token = request;
    autoTimer = window.setTimeout(() => {
      autoTimer = null;
      if (active() && options.autoEnabled() && !document.hidden && request === token && options.getText() === text && options.getItem?.()?.id === itemId) speakCurrent();
    }, 180);
  }
  const preview = (): void => {
    if (loading || !active()) return;
    if (catalog && audio) { const url = recordedVoice()?.previewUrl; if (url) playRecorded(url); }
    else speakSystem("Hello! Let's practice English together.");
  };
  const fallback = (): void => { const text = options.getText(); if (text) speakSystem(text); };
  const changeVoice = (): void => {
    if (!active() || !catalog || !voiceIds.includes(voiceSelect.value)) return;
    const next = voiceSelect.value;
    stop();
    voiceId = next;
    save();
    refresh();
  };
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
  const onOnline = (): void => { if (active()) void reloadCatalog(); };
  function loadCatalog(invalidate = false, initial = false): Promise<void> {
    if (destroyed) return Promise.resolve();
    if (catalogTask && !invalidate) return catalogTask;
    const sequence = ++catalogSequence;
    catalogAbort?.abort();
    if (catalogTimeout !== null) window.clearTimeout(catalogTimeout);
    const abort = new AbortController();
    catalogAbort = abort;
    const timeout = window.setTimeout(() => abort.abort(), 8_000);
    catalogTimeout = timeout;
    const task = fetch("/api/speech/catalog", { credentials: "same-origin", cache: "no-store", signal: abort.signal })
      .then(response => {
        if (!response.ok) throw new Error("Speech catalog unavailable");
        return response.json();
      })
      .then(value => {
        if (!destroyed && !abort.signal.aborted && sequence === catalogSequence) catalog = parseCatalog(value);
      })
      .catch(() => { /* Retain a previous catalog on transport failure; audio is still authorized on every request. */ })
      .finally(() => {
        window.clearTimeout(timeout);
        if (destroyed || sequence !== catalogSequence) return;
        catalogAbort = null;
        catalogTimeout = null;
        catalogTask = null;
        loading = false;
        refresh();
        // Later reloads update metadata only. The practice transition owns its single auto-play.
        if (initial && active() && options.autoEnabled() && !document.hidden) scheduleCurrent();
      });
    catalogTask = task;
    return task;
  }
  function reloadCatalog({ invalidate = false }: { invalidate?: boolean } = {}): Promise<void> {
    return loadCatalog(invalidate);
  }
  function destroy(): void {
    if (destroyed) return;
    stop();
    destroyed = true;
    catalogSequence += 1;
    catalogAbort?.abort();
    if (catalogTimeout !== null) window.clearTimeout(catalogTimeout);
    options.speakButton.removeEventListener("click", speakCurrent);
    previewButton.removeEventListener("click", preview);
    fallbackButton.removeEventListener("click", fallback);
    voiceSelect.removeEventListener("change", changeVoice);
    rateInput.removeEventListener("input", changeRate);
    synth?.removeEventListener("voiceschanged", onRefresh);
    window.removeEventListener("pagehide", stop);
    window.removeEventListener("pageshow", onRefresh);
    window.removeEventListener("online", onOnline);
    document.removeEventListener("visibilitychange", onVisibilityChange);
  }
  rateInput.value = String(rate);
  rateValue.textContent = `${rate.toFixed(2)} 倍`;
  options.speakButton.addEventListener("click", speakCurrent);
  previewButton.addEventListener("click", preview);
  fallbackButton.addEventListener("click", fallback);
  voiceSelect.addEventListener("change", changeVoice);
  rateInput.addEventListener("input", changeRate);
  synth?.addEventListener("voiceschanged", onRefresh);
  window.addEventListener("pagehide", stop);
  window.addEventListener("pageshow", onRefresh);
  window.addEventListener("online", onOnline);
  document.addEventListener("visibilitychange", onVisibilityChange);
  refresh();
  void loadCatalog(false, true);
  return { supported, speakCurrent, stop, scheduleCurrent, refresh, reloadCatalog, destroy };
}

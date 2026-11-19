import "./alignment";
import { trialExamples } from "./guest-trial-examples";
import type { AuthCapabilities } from "./types";
import { mustElement, siteFooterMarkup } from "./ui";
import { normalizeAnswer } from "./utils";

const durationMs = 10 * 60_000;
const deadlineKey = "cxzenglish.guestTrialDeadline";
let inMemoryDeadline: number | undefined;
let cleanup: (() => void) | undefined;

function trialDeadline(): number | undefined {
  try {
    const stored = Number(localStorage.getItem(deadlineKey));
    if (Number.isSafeInteger(stored) && stored > 0) {
      inMemoryDeadline = Math.min(inMemoryDeadline ?? stored, stored);
    }
  } catch {
    // The current tab can still keep time when browser storage is unavailable.
  }
  return inMemoryDeadline;
}

function startTrial(): number {
  const existing = trialDeadline();
  if (existing !== undefined) return existing;
  const deadline = Date.now() + durationMs;
  inMemoryDeadline = deadline;
  try { localStorage.setItem(deadlineKey, String(deadline)); } catch { /* Use the tab's deadline. */ }
  return deadline;
}

export function guestTrialEntryLabel(): string {
  const deadline = trialDeadline();
  if (deadline === undefined) return "立即试用";
  return deadline > Date.now() ? "继续试用" : "查看试用结果";
}

export function disposeGuestTrial(): void {
  cleanup?.();
  cleanup = undefined;
}

export function renderGuestTrial(
  app: HTMLElement,
  capabilities: AuthCapabilities,
  navigate: (path: string) => void
): void {
  disposeGuestTrial();
  const startedDeadline = startTrial();
  const canRegister = capabilities.emailAuthEnabled && capabilities.selfRegistrationEnabled;
  const registerUrl = canRegister ? "/login?mode=register" : "/login";
  const registerLabel = canRegister ? "免费注册" : "返回登录";
  app.innerHTML = `
    <main class="guest-trial">
      <header class="guest-trial-header">
        <div class="auth-brand">
          <span class="brand-mark" aria-hidden="true">ET</span>
          <div><h1>英语打字试用</h1><p>日常交流和四六级写作精选</p></div>
        </div>
        <a class="btn" href="/login" data-trial-link>已有账号？登录</a>
      </header>
      <section class="guest-trial-card" id="guestTrialPractice" hidden>
        <div class="guest-trial-meta">
          <span id="guestTrialCategory"></span>
          <span>试用剩余 <strong id="guestTrialTimer" role="timer" aria-live="off">10:00</strong></span>
        </div>
        <div class="prompt">
          <div class="alignment-scroll" id="trialAlignmentScroll">
            <div class="alignment-stage" id="trialAlignmentStage">
              <div class="target-word word" id="trialEnglish" lang="en"></div>
              <svg class="alignment-arrows" id="trialArrows" aria-hidden="true" focusable="false" hidden></svg>
              <div class="meaning" id="trialMeaning" lang="zh-CN"></div>
            </div>
          </div>
          <p class="alignment-note" id="trialAlignmentNote" role="status" hidden></p>
        </div>
        <form id="guestTrialForm" class="form-stack">
          <label class="field-label" for="guestTrialAnswer">照着上面的英文输入，按回车检查</label>
          <input class="input answer-input" id="guestTrialAnswer" type="text" autocomplete="off" autocapitalize="off" spellcheck="false">
          <div class="button-row">
            <button class="btn primary" type="submit">检查答案</button>
            <button class="btn" id="guestTrialSkip" type="button">下一题</button>
          </div>
          <div class="feedback guest-trial-feedback" id="guestTrialFeedback" role="status"></div>
        </form>
      </section>
      <section class="guest-trial-card guest-trial-end" id="guestTrialEnd" hidden>
        <h2>10 分钟试用已结束</h2>
        <p>${canRegister
          ? capabilities.membershipEnabled
            ? "用邮箱免费注册，即可领取 24 小时完整练习。"
            : "用邮箱免费注册，继续练习并同步学习记录。"
          : "登录后继续练习。当前暂未开放邮箱注册。"}</p>
        <a class="btn primary" href="${registerUrl}" data-trial-link>${registerLabel}</a>
      </section>
    </main>
    ${siteFooterMarkup()}
  `;

  app.querySelectorAll<HTMLAnchorElement>("[data-trial-link]").forEach((link) => {
    link.addEventListener("click", (event) => {
      if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      navigate(link.getAttribute("href")!);
    });
  });

  const practice = mustElement<HTMLElement>("#guestTrialPractice", app);
  const end = mustElement<HTMLElement>("#guestTrialEnd", app);
  const form = mustElement<HTMLFormElement>("#guestTrialForm", app);
  const timer = mustElement("#guestTrialTimer", app);
  const input = mustElement<HTMLInputElement>("#guestTrialAnswer", app);
  const category = mustElement("#guestTrialCategory", app);
  const feedback = mustElement<HTMLElement>("#guestTrialFeedback", app);
  const english = mustElement<HTMLElement>("#trialEnglish", app);
  const meaning = mustElement<HTMLElement>("#trialMeaning", app);
  let renderer: ReturnType<NonNullable<typeof window.WordAlignment>["create"]> | undefined;
  let interval: number | undefined;
  let index = 0;

  function showTime(): boolean {
    const remaining = (trialDeadline() ?? startedDeadline) - Date.now();
    if (remaining <= 0) {
      const wasPracticing = !practice.hidden;
      practice.hidden = true;
      end.hidden = false;
      if (interval !== undefined) window.clearInterval(interval);
      renderer?.destroy();
      renderer = undefined;
      if (wasPracticing) mustElement<HTMLAnchorElement>("a", end).focus();
      return false;
    }
    const seconds = Math.ceil(remaining / 1000);
    timer.textContent = `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
    return true;
  }

  function showExample(): void {
    const sample = trialExamples[index]!;
    category.textContent = sample.category;
    input.value = "";
    if (renderer) renderer.render({ word: sample.english, meaning: sample.meaning, kind: "sentence" }, { enabled: true, showEnglish: true });
    else {
      english.textContent = sample.english;
      meaning.textContent = sample.meaning;
    }
    input.focus({ preventScroll: true });
  }

  function advance(): void {
    index = (index + 1) % trialExamples.length;
    showExample();
  }

  if (!showTime()) return;
  practice.hidden = false;
  renderer = window.WordAlignment?.create({
    scroll: mustElement("#trialAlignmentScroll", app),
    stage: mustElement("#trialAlignmentStage", app),
    english,
    meaning,
    svg: mustElement<SVGSVGElement>("#trialArrows", app),
    note: mustElement("#trialAlignmentNote", app)
  });
  renderer?.setData({ version: 1, entries: trialExamples });
  renderer?.bindInput(input);
  showExample();
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    if (!showTime()) return;
    if (normalizeAnswer(input.value) === normalizeAnswer(trialExamples[index]!.english)) {
      feedback.textContent = "答对了，继续下一题。";
      feedback.dataset.result = "correct";
      advance();
    } else {
      feedback.textContent = "再对照一下上面的句子，留意空格和标点。";
      feedback.dataset.result = "incorrect";
      input.focus();
    }
  });
  mustElement("#guestTrialSkip", app).addEventListener("click", () => {
    if (!showTime()) return;
    feedback.textContent = "";
    advance();
  });
  const events = new AbortController();
  document.addEventListener("visibilitychange", showTime, { signal: events.signal });
  window.addEventListener("pageshow", showTime, { signal: events.signal });
  window.addEventListener("storage", showTime, { signal: events.signal });
  interval = window.setInterval(showTime, 250);
  cleanup = () => {
    window.clearInterval(interval);
    events.abort();
    renderer?.destroy();
  };
}

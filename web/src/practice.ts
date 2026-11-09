import { accountMarkup, bindAccountSecurity } from "./account-security";
import { membershipLabel } from "./membership";
import { createPracticeAlignment } from "./alignment";
import { createWritingPreview } from "./cet4-writing";
import { createPracticeLayout } from "./practice-layout";
import { createSpeechController, speechSettingsMarkup } from "./speech";
import { ApiError, api } from "./api";
import { practiceBatchId } from "./routes";

import type {
  AttemptResponse,
  AttemptSummary,
  ContentCategory,
  ContentItem,
  ContentResponse,
  ImportBatchContentResponse,
  MistakeRecord,
  OrderMode,
  PageContext,
  PracticeSession,
  User
} from "./types";
import { errorMarkup, mustElement, setBusy, showToast } from "./ui";
import {
  buildPracticePool,
  escapeHtml,
  getErrorMessage,
  newId,
  normalizeAnswer,
  parseLegacyMistakes,
  shouldRefreshContentForAttemptError,
} from "./utils";

interface PendingAttempt {
  sessionId: string;
  payload: {
    clientAttemptId: string;
    itemId: string;
    itemRevision: number;
    answer: string;
    durationMs: number;
    occurredAt: string;
  };
  advanceOnWrong: boolean;
}

interface PracticeState {
  context: PageContext;
  importBatchId?: string;
  batch?: ImportBatchContentResponse["batch"];
  unavailableCount: number;
  categories: ContentCategory[];
  items: ContentItem[];
  mistakes: MistakeRecord[];
  mistakeIds: Set<string>;
  pool: ContentItem[];
  index: number;
  categoryId: string;
  mode: OrderMode;
  session: PracticeSession | null;
  sessionStartedAtMs: number;
  itemStartedAtMs: number;
  summary: AttemptSummary;
  lifetime: {
    sessions: number;
    attempts: number;
    correct: number;
    accuracy: number;
    bestStreak: number;
    durationMs: number;
  };
  localDone: number;
  localCorrect: number;
  localStreak: number;
  currentHadWrongAttempt: boolean;
  submitting: boolean;
  transitioning: boolean;
  pendingAttempt: PendingAttempt | null;
  pendingSessionStart: boolean;
  rebuilding: boolean;
  contentRefreshing: boolean;
  mistakeRefreshSequence: number;
  contentRefreshRequired: boolean;
  showEnglish: boolean;
  autoSpeak: boolean;
  legacyKeys: string[];
  disposed: boolean;
  membershipBlocked: boolean;
  resumeTransition: (() => void) | null;
}

let state: PracticeState | null = null;
let accountSecurity: ReturnType<typeof bindAccountSecurity> | null = null;
let membershipTimer: number | undefined;
let renderGeneration = 0;
let alignmentController: ReturnType<typeof createPracticeAlignment> | null = null;
let writingController: ReturnType<typeof createWritingPreview> | null = null;
let layoutController: ReturnType<typeof createPracticeLayout> | null = null;
let speechController: ReturnType<typeof createSpeechController> | null = null;

function ensureMembershipNotice(): void {
  if (document.querySelector("#practiceMembership")) return;
  const notice = document.createElement("div");
  notice.id = "practiceMembership";
  notice.className = "message info membership-notice";
  notice.innerHTML = `<span id="practiceMembershipText"></span><a class="btn small" href="/membership" target="_blank" rel="noopener">会员与记录</a><button class="btn small" type="button" id="practiceMembershipRefresh">核实会员状态</button>`;
  document.querySelector(".page-title")?.after(notice);
  notice.querySelector("#practiceMembershipRefresh")!.addEventListener("click", () => void checkMembership());
}

function handleMembershipError(error: unknown): boolean {
  if (!(error instanceof ApiError) || error.code !== "MEMBERSHIP_REQUIRED" || !state) return false;
  ensureMembershipNotice();
  state.membershipBlocked = true;
  speechController?.stop();
  state.autoSpeak = false;
  const auto = document.querySelector<HTMLInputElement>("#autoSpeak");
  if (auto) { auto.checked = false; auto.disabled = true; }
  const speak = document.querySelector<HTMLButtonElement>("#speakButton");
  if (speak) speak.disabled = true;
  setPracticeInputsDisabled(true);
  document.querySelector<HTMLDetailsElement>("#cet4Writing details")?.removeAttribute("open");
  document.querySelector("#cet4Writing")?.setAttribute("inert", "");
  setSyncProblem("试用或会员已到期，当前输入保留。请在“会员与记录”中续费，然后核实会员状态。", null);
  const text = document.querySelector("#practiceMembershipText");
  if (text) text.textContent = "试用或会员已到期";
  return true;
}
let membershipCheckOwner: PracticeState | null = null;
async function checkMembership(): Promise<void> {
  if (!state || membershipCheckOwner === state) return;
  const activeState = state;
  membershipCheckOwner = activeState;
  try {
    const membership = await api.membership();
    if (!isActive(activeState)) return;
    const text = document.querySelector("#practiceMembershipText");
    if (text) text.textContent = membershipLabel(membership);
    if (!membership.access.canPractice) {
      handleMembershipError(new ApiError(403, "MEMBERSHIP_REQUIRED", "会员已到期"));
    } else if (state.membershipBlocked) {
      state.membershipBlocked = false;
      document.querySelector("#cet4Writing")?.removeAttribute("inert");
      const auto = document.querySelector<HTMLInputElement>("#autoSpeak");
      if (auto) auto.disabled = !speechController?.supported;
      speechController?.refresh();
      clearSyncProblem();
      if (state.resumeTransition) { const resume = state.resumeTransition; state.resumeTransition = null; resume(); }
      else if (state.pendingAttempt) await sendPendingAttempt();
      else if (!state.session) await startPracticeSession();
      else setPracticeInputsDisabled(false);
    }
  } catch (error) { if (isActive(activeState) && !state.context.handleAuthError(error)) showToast(getErrorMessage(error, "会员状态读取失败"), "error"); }
  finally { if (membershipCheckOwner === activeState) membershipCheckOwner = null; }
}

function isActive(activeState: PracticeState): boolean {
  return state === activeState && !activeState.disposed;
}

export function confirmDiscardPendingAttempt(): boolean {
  if (!state?.pendingAttempt) return true;
  return window.confirm("当前答题尚未同步。现在离开会丢弃这次未确认的答题，确定继续吗？");
}

function onBeforeUnload(event: BeforeUnloadEvent): void {
  if (!state?.pendingAttempt) return;
  event.preventDefault();
  event.returnValue = "";
}

function metric(summary: AttemptSummary, keys: string[], fallback: number): number {
  for (const key of keys) {
    const value = summary[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return fallback;
}

function categoriesMarkup(categories: ContentCategory[]): string {
  return categories
    .filter((category) => category.status !== "archived" && category.status !== "draft")
    .sort((a, b) => (a.kind === b.kind ? a.sortOrder - b.sortOrder : a.kind === "word" ? -1 : 1))
    .map((category) => `<option value="${escapeHtml(category.id)}">${escapeHtml(category.name)}</option>`)
    .join("");
}

function practiceMarkup(
  categories: ContentCategory[],
  wordCount: number,
  sentenceCount: number,
  hasLegacyMistakes: boolean,
  user: User,
  emailAuthEnabled: boolean,
  batch?: ImportBatchContentResponse["batch"],
  unavailableCount = 0
): string {
  return `
    <div class="page-title">
      <div>
        <h1>英语打字练习</h1>
        <p>已载入 ${wordCount} 个单词，${sentenceCount} 条句型 · 学习记录已同步到当前账号</p>
      </div>
      <section class="stats" aria-label="练习统计">
        <div class="stat"><span>完成</span><strong id="doneStat">0</strong></div>
        <div class="stat"><span>正确率</span><strong id="accuracyStat">0%</strong></div>
        <div class="stat"><span>连击</span><strong id="streakStat">0</strong></div>
        <div class="stat"><span>错题</span><strong id="mistakeStat">0</strong></div>
      </section>
    </div>

    ${batch ? `<section class="message info" id="importBatchBanner">
      <div><strong>本次文件：${escapeHtml(batch.fileName)}</strong><p id="batchAvailabilityNote">只练这份文件中的 ${wordCount + sentenceCount} 道已发布题目${unavailableCount ? `，另有 ${unavailableCount} 道已不可练习` : ""}。</p></div>
      <button class="btn small" id="exitImportBatchButton" type="button">退出本次文件练习</button>
    </section>` : ""}
    <section class="legacy-banner message info" id="legacyBanner"${hasLegacyMistakes ? "" : " hidden"}>
      <span>发现此浏览器旧版错题记录（<strong id="legacyCount">${hasLegacyMistakes ? "" : "0"}</strong> 条），可一次性导入当前账号。</span>
      <div class="inline-actions">
        <button class="btn small" id="dismissLegacyButton" type="button">稍后</button>
        <button class="btn primary small" id="importLegacyButton" type="button">确认导入</button>
      </div>
    </section>

    <div id="layoutControls"></div>
    <main class="panel practice-card">
      <section class="practice-controls" aria-label="练习设置">
        <label class="field">
          <span>内容分类</span>
          <select class="select" id="categorySelect"${batch ? " disabled" : ""}>
            <option value="all">${batch ? "本次文件全部内容" : "全部内容"}</option>
            ${batch ? "" : categoriesMarkup(categories)}
          </select>
        </label>
        <label class="field">
          <span>顺序</span>
          <select class="select" id="orderSelect">
            <option value="order">顺序</option>
            <option value="shuffle">随机</option>
            <option value="mistakes">错题</option>
          </select>
        </label>
        <div class="toggle-group" aria-label="辅助设置">
          <label class="toggle-line"><input id="showEnglish" type="checkbox" checked> 显示英文</label>
          <label class="toggle-line"><input id="showAlignment" type="checkbox" checked> 对应箭头</label>
          <label class="toggle-line"><input id="autoSpeak" type="checkbox"> 自动朗读</label>
        </div>
        <div class="practice-actions">
          <button class="btn" id="resetButton" type="button">重来</button>
          <button class="btn" id="speakButton" type="button">朗读</button>
          <button class="btn primary" id="nextButton" type="button">下一个</button>
        </div>
      </section>

      ${speechSettingsMarkup()}

      <div class="sync-strip" id="syncStrip" hidden>
        <span id="syncMessage">本次答题尚未同步，请检查网络。</span>
        <button class="btn small" id="retrySyncButton" type="button">重试同步</button>
      </div>

      <section class="practice-grid">
        <div class="practice-main">
          <div class="progress-wrap">
            <div class="progress-meta">
              <span id="positionText">0 / 0</span>
              <span id="categoryText">全部内容</span>
            </div>
            <progress class="progress-bar" id="progressBar" value="0" max="1">0%</progress>
          </div>

          <section id="cet4Writing" class="cet4-writing" aria-label="四六级作文全文" hidden></section>
          <div class="prompt">
            <div class="alignment-scroll" id="alignmentScroll">
              <div class="alignment-stage" id="alignmentStage">
                <div class="target-word word" id="targetWord" lang="en">正在准备练习…</div>
                <svg class="alignment-arrows" id="alignmentArrows" aria-hidden="true" focusable="false" hidden></svg>
                <div class="meaning" id="meaningText" lang="zh-CN"></div>
              </div>
            </div>
            <p class="alignment-note" id="alignmentNote" role="status" aria-live="polite" hidden></p>
            <div class="pronunciation" id="pronunciationText"></div>
          </div>

          <div>
            <label class="field-label" for="answerInput">输入英文答案</label>
            <input class="input answer-input" id="answerInput" type="text" autocomplete="off" autocapitalize="off" spellcheck="false">
            <div class="letters" id="letters" aria-hidden="true"></div>
          </div>
          <div class="feedback" id="feedback" role="status"></div>
        </div>

        <aside class="practice-side">
          <div class="panel-heading">
            <h2>错题本</h2>
            <button class="btn ghost small" id="refreshMistakesButton" type="button">刷新</button>
          </div>
          <div class="review-list" id="reviewList"></div>
          <div class="side-summary">
            <h3>个人累计</h3>
            <div class="summary-pairs">
              <span>练习轮次</span><strong id="lifetimeSessions">0</strong>
              <span>累计答题</span><strong id="lifetimeAttempts">0</strong>
              <span>累计正确率</span><strong id="lifetimeAccuracy">0%</strong>
              <span>最佳连击</span><strong id="lifetimeBestStreak">0</strong>
            </div>
          </div>
        </aside>
      </section>
    </main>

    ${accountMarkup(user, emailAuthEnabled)}
  `;
}

function currentItem(): ContentItem | null {
  if (!state) return null;
  return state.pool[state.index] ?? null;
}

function renderPrompt(): void {
  if (!state) return;
  const item = currentItem();
  const target = mustElement<HTMLElement>("#targetWord");
  const meaning = mustElement<HTMLElement>("#meaningText");
  target.className = `target-word word${item?.kind === "sentence" ? " sentence" : ""}${(item?.english.length ?? 0) > 42 ? " long" : ""}`;
  alignmentController?.render(item, { showEnglish: state.showEnglish });
  writingController?.render(item, state.items, state.categories, state.showEnglish);
  if (!item) {
    target.textContent = state.importBatchId && !state.items.length ? "本次文件暂无可练习内容" : state.mode === "mistakes" ? "错题已练完" : "暂无词条";
    meaning.textContent = state.importBatchId && !state.items.length
      ? "这些题目或所属分类可能已下架。可退出本次文件练习后选择其他内容。"
      : state.mode === "mistakes" ? "当前筛选下没有待复习的错题。" : "当前分类暂时没有已发布内容。";
  }
}

function renderLetters(): void {
  if (!state) return;
  alignmentController?.syncInput();
  const item = currentItem();
  const container = mustElement<HTMLElement>("#letters");
  container.replaceChildren();
  if (!item) return;
  const answer = mustElement<HTMLInputElement>("#answerInput").value;
  [...item.english].forEach((character, index) => {
    const letter = document.createElement("span");
    letter.className = "letter";
    if (index === answer.length) letter.classList.add("current");
    const typed = answer[index];
    if (typed) letter.classList.add(typed.toLocaleLowerCase("en-US") === character.toLocaleLowerCase("en-US") ? "ok" : "bad");
    letter.textContent = state?.showEnglish ? character : (typed ?? " ");
    container.append(letter);
  });
}

function renderStats(): void {
  if (!state) return;
  const done = metric(state.summary, ["done", "totalAttempts"], state.localDone);
  const correct = metric(state.summary, ["correct", "correctAttempts"], state.localCorrect);
  const rawAccuracy = metric(state.summary, ["accuracy"], done ? (correct / done) * 100 : 0);
  const accuracy = rawAccuracy <= 1 && rawAccuracy > 0 ? rawAccuracy * 100 : rawAccuracy;
  const streak = metric(state.summary, ["streak", "currentStreak"], state.localStreak);
  const mistakes = state.importBatchId ? state.mistakes.length : metric(state.summary, ["mistakes", "mistakeCount"], state.mistakes.length);
  mustElement<HTMLElement>("#doneStat").textContent = String(Math.max(0, Math.round(done)));
  mustElement<HTMLElement>("#accuracyStat").textContent = `${Math.max(0, Math.min(100, Math.round(accuracy)))}%`;
  mustElement<HTMLElement>("#streakStat").textContent = String(Math.max(0, Math.round(streak)));
  mustElement<HTMLElement>("#mistakeStat").textContent = String(Math.max(0, Math.round(mistakes)));
  mustElement<HTMLElement>("#lifetimeSessions").textContent = String(state.lifetime.sessions);
  mustElement<HTMLElement>("#lifetimeAttempts").textContent = String(state.lifetime.attempts);
  mustElement<HTMLElement>("#lifetimeAccuracy").textContent = `${Math.round(state.lifetime.accuracy * 100)}%`;
  mustElement<HTMLElement>("#lifetimeBestStreak").textContent = String(state.lifetime.bestStreak);
}

function renderMistakes(): void {
  if (!state) return;
  const container = mustElement<HTMLElement>("#reviewList");
  container.replaceChildren();
  if (!state.mistakes.length) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = "暂无错题。答错的内容会自动同步到这里。";
    container.append(empty);
    renderStats();
    return;
  }
  for (const record of state.mistakes.slice(0, 50)) {
    const card = document.createElement("div");
    card.className = "review-item";
    const english = document.createElement("strong");
    english.textContent = record.item.english;
    const meaning = document.createElement("span");
    meaning.textContent = record.item.meaning;
    const meta = document.createElement("span");
    meta.textContent = `错误 ${record.wrongCount} 次`;
    card.append(english, meaning, meta);
    container.append(card);
  }
  renderStats();
}

function setSyncProblem(message: string, retryLabel: string | null = "重试同步"): void {
  const strip = document.querySelector<HTMLElement>("#syncStrip");
  const text = document.querySelector<HTMLElement>("#syncMessage");
  const retryButton = document.querySelector<HTMLButtonElement>("#retrySyncButton");
  if (!strip || !text || !retryButton) return;
  text.textContent = message;
  retryButton.hidden = retryLabel === null;
  if (retryLabel) retryButton.textContent = retryLabel;
  strip.hidden = false;
}

function clearSyncProblem(): void {
  const strip = document.querySelector<HTMLElement>("#syncStrip");
  if (strip) strip.hidden = true;
  const retryButton = document.querySelector<HTMLButtonElement>("#retrySyncButton");
  if (retryButton) {
    retryButton.hidden = false;
    retryButton.textContent = "重试同步";
  }
}

function setPracticeInputsDisabled(disabled: boolean): void {
  document.querySelectorAll<HTMLButtonElement | HTMLInputElement | HTMLSelectElement>(
    "#answerInput, #nextButton, #resetButton, #categorySelect, #orderSelect"
  ).forEach((element) => { element.disabled = Boolean(state?.membershipBlocked) || disabled || (element.id === "categorySelect" && Boolean(state?.importBatchId)); });
}

function renderCurrent(): void {
  if (!state || state.membershipBlocked) return;
  const activeState = state;
  speechController?.stop();
  const item = currentItem();
  const total = state.pool.length;
  const answerInput = mustElement<HTMLInputElement>("#answerInput");
  const nextButton = mustElement<HTMLButtonElement>("#nextButton");
  const speakButton = mustElement<HTMLButtonElement>("#speakButton");
  const pronunciation = mustElement<HTMLElement>("#pronunciationText");
  const feedback = mustElement<HTMLElement>("#feedback");
  const progress = mustElement<HTMLProgressElement>("#progressBar");

  mustElement<HTMLElement>("#positionText").textContent = total ? `${state.index + 1} / ${total}` : "0 / 0";
  const selectedCategoryId = state.categoryId;
  const category = state.categories.find((entry) => entry.id === selectedCategoryId);
  const itemCategory = state.categories.find((entry) => entry.id === item?.categoryId);
  mustElement<HTMLElement>("#categoryText").textContent = state.importBatchId
    ? `本次文件${itemCategory ? ` · ${itemCategory.name}` : ""}` : category?.name ?? "全部内容";
  progress.max = Math.max(1, total);
  progress.value = total ? state.index : 0;

  answerInput.value = "";
  feedback.textContent = "";
  feedback.className = "feedback";
  state.currentHadWrongAttempt = false;
  state.itemStartedAtMs = Date.now();
  setPracticeInputsDisabled(!state.session || state.submitting || state.transitioning || state.rebuilding || Boolean(state.pendingAttempt));

  renderPrompt();
  speechController?.refresh();
  if (!item) {
    pronunciation.textContent = "";
    pronunciation.hidden = true;
    answerInput.disabled = true;
    nextButton.disabled = true;
    speakButton.disabled = true;
    renderLetters();
    return;
  }

  pronunciation.textContent = item.pronunciation ? `中文谐音：${item.pronunciation}` : "";
  pronunciation.hidden = !item.pronunciation;
  answerInput.disabled = !state.session || state.submitting || state.transitioning || Boolean(state.pendingAttempt);
  nextButton.disabled = !state.session || state.submitting || state.transitioning || Boolean(state.pendingAttempt);
  renderLetters();
  window.setTimeout(() => { if (isActive(activeState)) answerInput.focus(); }, 0);
  if (state.autoSpeak && state.session) speechController?.scheduleCurrent();
}

async function refreshMistakes(): Promise<void> {
  if (!state || state.disposed) return;
  const activeState = state;
  const sequence = ++activeState.mistakeRefreshSequence;
  try {
    const response = await api.mistakes();
    if (!isActive(activeState) || sequence !== activeState.mistakeRefreshSequence) return;
    if (response.locked) { handleMembershipError(new ApiError(403, "MEMBERSHIP_REQUIRED", "会员已到期")); return; }
    state.mistakes = mistakesInScope(response.items ?? [], state.items, state.importBatchId);
    state.mistakeIds = new Set(state.mistakes.map((record) => record.item.id));
    renderMistakes();
  } catch (error) {
    if (!isActive(activeState) || sequence !== activeState.mistakeRefreshSequence) return;
    if (!state?.context.handleAuthError(error)) showToast(getErrorMessage(error, "错题刷新失败"), "error");
  }
}

function mistakesInScope(mistakes: MistakeRecord[], items: ContentItem[], importBatchId?: string): MistakeRecord[] {
  if (!importBatchId) return mistakes;
  const ids = new Set(items.map((item) => item.id));
  return mistakes.filter((record) => ids.has(record.item.id));
}

function loadPracticeContent(importBatchId?: string): Promise<ContentResponse | ImportBatchContentResponse> {
  return importBatchId ? api.importBatchContent(importBatchId) : api.content();
}

function arrangePracticeContent(content: ContentResponse, importBatchId?: string) {
  // The batch endpoint returns source-file order, independent of the bank's category order.
  return importBatchId ? { categories: content.categories, items: content.items } : sortContent(content.categories, content.items);
}

function sortContent(categories: ContentCategory[], items: ContentItem[]): {
  categories: ContentCategory[];
  items: ContentItem[];
} {
  const sortedCategories = [...categories].sort((a, b) => (
    a.kind === b.kind ? a.sortOrder - b.sortOrder : a.kind === "word" ? -1 : 1
  ));
  const categoryOrder = new Map(sortedCategories.map((category, index) => [category.id, index]));
  const sortedItems = [...items].sort((a, b) => {
    const categoryDifference = (categoryOrder.get(a.categoryId) ?? 9999) - (categoryOrder.get(b.categoryId) ?? 9999);
    return categoryDifference || a.sortOrder - b.sortOrder;
  });
  return { categories: sortedCategories, items: sortedItems };
}

async function refreshContentAfterConflict(): Promise<void> {
  if (!state || state.disposed || state.contentRefreshing) return;
  const activeState = state;
  speechController?.stop();
  state.contentRefreshing = true;
  state.mistakeRefreshSequence += 1;
  state.contentRefreshRequired = true;
  state.pendingAttempt = null;
  state.submitting = false;
  state.transitioning = false;
  setPracticeInputsDisabled(true);
  setSyncProblem("题库内容已由管理员更新，正在重新加载。当前答案没有计入练习记录。", null);
  try {
    const [content, mistakes] = await Promise.all([loadPracticeContent(activeState.importBatchId), api.mistakes()]);
    if (!isActive(activeState)) return;
    const sorted = arrangePracticeContent(content, state.importBatchId);
    state.categories = sorted.categories;
    state.items = sorted.items;
    state.mistakes = mistakesInScope(mistakes.items ?? [], state.items, state.importBatchId);
    state.mistakeIds = new Set(state.mistakes.map((record) => record.item.id));
    const selectedCategoryId = state.categoryId;
    if (selectedCategoryId !== "all" && !state.categories.some((category) => category.id === selectedCategoryId)) {
      state.categoryId = "all";
    }
    const categorySelect = mustElement<HTMLSelectElement>("#categorySelect");
    categorySelect.innerHTML = `<option value="all">${state.importBatchId ? "本次文件全部内容" : "全部内容"}</option>${state.importBatchId ? "" : categoriesMarkup(state.categories)}`;
    categorySelect.value = state.categoryId;
    const wordCount = state.items.filter((item) => item.kind === "word").length;
    const sentenceCount = state.items.filter((item) => item.kind === "sentence").length;
    const subtitle = document.querySelector<HTMLElement>(".page-title p");
    if (subtitle) subtitle.textContent = `已载入 ${wordCount} 个单词，${sentenceCount} 条句型 · 学习记录已同步到当前账号`;
    if (state.importBatchId && "batch" in content) {
      state.unavailableCount = content.unavailableCount;
      const note = document.querySelector<HTMLElement>("#batchAvailabilityNote");
      if (note) note.textContent = `只练这份文件中的 ${state.items.length} 道已发布题目${state.unavailableCount ? `，另有 ${state.unavailableCount} 道已不可练习` : ""}。`;
    }
    state.contentRefreshRequired = false;
    await rebuildPool();
    if (!isActive(activeState)) return;
    if (!state.session) return;
    setSyncProblem("题库已更新并重新加载。请根据当前显示的新内容重新作答。", null);
    showToast("检测到题库版本更新，当前练习内容已刷新", "info", 7000);
  } catch (error) {
    if (!isActive(activeState)) return;
    if (handleMembershipError(error) || state.context.handleAuthError(error)) return;
    state.contentRefreshRequired = true;
    setPracticeInputsDisabled(true);
    setSyncProblem(`${getErrorMessage(error, "题库刷新失败")}。请重新加载题库后继续练习。`, "重新加载题库");
  } finally {
    activeState.contentRefreshing = false;
  }
}

function nextItem(delay = 0, removeCurrent = false): void {
  if (!state) return;
  const activeState = state;
  const session = state.session;
  const move = (): void => {
    if (!isActive(activeState) || state?.session !== session || !state.pool.length) return;
    if (state.membershipBlocked) { state.resumeTransition = move; return; }
    state.resumeTransition = null;
    state.transitioning = false;
    if (removeCurrent) state.pool.splice(state.index, 1);
    else state.index += 1;
    if (state.index >= state.pool.length) {
      state.index = 0;
      if (!removeCurrent && state.mode === "shuffle") {
        state.pool = buildPracticePool(state.items, state.categoryId, state.mode, state.mistakeIds);
      }
    }
    renderCurrent();
  };
  if (delay) window.setTimeout(move, delay); else move();
}

function applyAttemptResponse(response: AttemptResponse, submittedAnswer: string, advanceOnWrong: boolean): void {
  if (!state) return;
  const item = currentItem();
  if (!item) return;
  const correct = response.attempt?.correct
    ?? response.correct
    ?? normalizeAnswer(submittedAnswer) === normalizeAnswer(item.english);
  state.summary = response.summary ?? state.summary;
  state.localDone += 1;
  state.lifetime.attempts += 1;
  if (correct) {
    state.localCorrect += 1;
    state.lifetime.correct += 1;
    state.localStreak = state.currentHadWrongAttempt ? 0 : state.localStreak + 1;
  } else {
    state.currentHadWrongAttempt = true;
    state.localStreak = 0;
  }
  state.lifetime.accuracy = state.lifetime.attempts ? state.lifetime.correct / state.lifetime.attempts : 0;
  // Each accepted submission accounts for only the time spent since the last
  // accepted submission, not the cumulative time on a repeatedly retried item.
  state.itemStartedAtMs = Date.now();
  state.lifetime.bestStreak = Math.max(
    state.lifetime.bestStreak,
    metric(response.summary ?? {}, ["streak", "currentStreak"], state.localStreak)
  );
  const feedback = mustElement<HTMLElement>("#feedback");
  if (correct) {
    state.transitioning = true;
    setPracticeInputsDisabled(true);
    feedback.textContent = "正确，已同步";
    feedback.className = "feedback good";
    nextItem(360, state.mode === "mistakes");
  } else {
    feedback.textContent = `应输入：${response.expected || item.english}`;
    feedback.className = "feedback bad";
    if (advanceOnWrong) {
      state.transitioning = true;
      setPracticeInputsDisabled(true);
      nextItem(620);
    } else {
      setPracticeInputsDisabled(false);
      mustElement<HTMLInputElement>("#answerInput").select();
    }
  }
  renderStats();
  void refreshMistakes();
}

async function sendPendingAttempt(): Promise<void> {
  if (!state?.pendingAttempt || state.submitting || state.membershipBlocked) return;
  const activeState = state;
  const pending = state.pendingAttempt;
  state.submitting = true;
  setPracticeInputsDisabled(true);
  clearSyncProblem();
  try {
    const response = await api.attempt(pending.sessionId, pending.payload);
    if (!isActive(activeState)) return;
    state.pendingAttempt = null;
    state.submitting = false;
    applyAttemptResponse(response, pending.payload.answer, pending.advanceOnWrong);
  } catch (error) {
    if (!isActive(activeState)) return;
    state.submitting = false;
    if (handleMembershipError(error) || state.context.handleAuthError(error)) return;
    if (error instanceof ApiError && shouldRefreshContentForAttemptError(error.code)) {
      await refreshContentAfterConflict();
      return;
    }
    setPracticeInputsDisabled(true);
    setSyncProblem(`${getErrorMessage(error)}。答题结果尚未丢弃，请点击“重试同步”。`);
  }
}

async function submitAnswer(answer: string, advanceOnWrong: boolean): Promise<void> {
  if (!state || !state.session || state.membershipBlocked || state.submitting || state.transitioning || state.pendingAttempt) return;
  const item = currentItem();
  if (!item) return;
  state.pendingAttempt = {
    sessionId: state.session.id,
    payload: {
      clientAttemptId: newId(),
      itemId: item.id,
      itemRevision: item.revision,
      answer,
      durationMs: Math.min(3_600_000, Math.max(0, Date.now() - state.itemStartedAtMs)),
      occurredAt: new Date().toISOString()
    },
    advanceOnWrong
  };
  await sendPendingAttempt();
}

async function finishOldSession(): Promise<void> {
  if (!state?.session) return;
  const activeState = state;
  const session = state.session;
  const durationMs = Math.min(86_400_000, Math.max(0, Date.now() - state.sessionStartedAtMs));
  state.session = null;
  try {
    await api.finishPracticeSession(session.id, durationMs);
  } catch (error) {
    if (isActive(activeState) && !activeState.context.handleAuthError(error)) {
      showToast("上一轮练习的结束状态未同步，但已提交的答题记录仍然保留。", "error");
    }
  }
}

async function startPracticeSession(): Promise<void> {
  if (!state || state.disposed || state.membershipBlocked || state.pendingSessionStart || state.session) return;
  if (state.importBatchId && !state.items.length) { renderCurrent(); return; }
  const activeState = state;
  state.pendingSessionStart = true;
  setPracticeInputsDisabled(true);
  clearSyncProblem();
  try {
    const response = await api.createPracticeSession(state.categoryId, state.mode, state.importBatchId);
    if (!isActive(activeState)) return;
    state.session = response.session;
    state.sessionStartedAtMs = Date.now();
    state.lifetime.sessions += 1;
    state.pendingSessionStart = false;
    setPracticeInputsDisabled(false);
    renderStats();
    renderCurrent();
  } catch (error) {
    if (!isActive(activeState)) return;
    state.pendingSessionStart = false;
    if (handleMembershipError(error) || state.context.handleAuthError(error)) return;
    setPracticeInputsDisabled(true);
    setSyncProblem(`${getErrorMessage(error, "无法开始练习")}。本应用需要联网，请连接后重试。`);
  }
}

async function rebuildPool(): Promise<void> {
  if (!state || state.membershipBlocked || state.rebuilding || state.pendingSessionStart || state.transitioning) return;
  const activeState = state;
  if (state.pendingAttempt) {
    setSyncProblem("请先重试同步当前答题，再切换练习设置。");
    return;
  }
  speechController?.stop();
  state.rebuilding = true;
  setPracticeInputsDisabled(true);
  const oldSession = state.session;
  if (oldSession) await finishOldSession();
  if (!isActive(activeState)) return;
  state.pool = buildPracticePool(state.items, state.categoryId, state.mode, state.mistakeIds);
  state.index = 0;
  state.summary = {};
  state.localDone = 0;
  state.localCorrect = 0;
  state.localStreak = 0;
  state.transitioning = false;
  state.rebuilding = false;
  renderStats();
  renderCurrent();
  await startPracticeSession();
}

async function importLegacyMistakes(button: HTMLButtonElement): Promise<void> {
  if (!state?.legacyKeys.length || button.disabled) return;
  const activeState = state;
  setBusy(button, true, "正在导入…");
  try {
    const response = await api.importMistakes(state.legacyKeys);
    if (!isActive(activeState)) return;
    localStorage.removeItem("basicTypingMistakes");
    state.legacyKeys = [];
    mustElement<HTMLElement>("#legacyBanner").hidden = true;
    const unmatched = Array.isArray(response.unmatched) ? response.unmatched.length : response.unmatched;
    showToast(`旧错题导入完成：新增 ${response.imported} 条${unmatched ? `，未匹配 ${unmatched} 条` : ""}`, "success", 7000);
    await refreshMistakes();
    if (isActive(activeState) && state?.mode === "mistakes") await rebuildPool();
  } catch (error) {
    if (!isActive(activeState)) return;
    if (!state?.context.handleAuthError(error)) showToast(getErrorMessage(error, "旧错题导入失败"), "error");
    setBusy(button, false);
  }
}

function bindPracticeEvents(): void {
  const answer = mustElement<HTMLInputElement>("#answerInput");
  const category = mustElement<HTMLSelectElement>("#categorySelect");
  const order = mustElement<HTMLSelectElement>("#orderSelect");
  const showEnglish = mustElement<HTMLInputElement>("#showEnglish");
  const autoSpeak = mustElement<HTMLInputElement>("#autoSpeak");
  document.querySelector<HTMLButtonElement>("#exitImportBatchButton")?.addEventListener("click", () => {
    state?.context.navigate("/practice");
  });

  answer.addEventListener("input", () => {
    if (!state || state.submitting || state.transitioning || state.pendingAttempt) return;
    renderLetters();
    const item = currentItem();
    if (item && normalizeAnswer(answer.value) === normalizeAnswer(item.english)) {
      void submitAnswer(answer.value, false);
    }
  });
  answer.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" || !state || state.submitting || state.transitioning || state.pendingAttempt) return;
    const item = currentItem();
    if (!item) return;
    const value = answer.value.trim();
    if (!value) nextItem();
    else void submitAnswer(value, false);
  });
  category.addEventListener("change", () => {
    if (!state || state.importBatchId) return;
    state.categoryId = category.value;
    void rebuildPool();
  });
  order.addEventListener("change", () => {
    if (!state) return;
    state.mode = order.value as OrderMode;
    void rebuildPool();
  });
  showEnglish.addEventListener("change", () => {
    if (!state) return;
    state.showEnglish = showEnglish.checked;
    renderPrompt();
    renderLetters();
    answer.focus();
  });
  autoSpeak.addEventListener("change", () => {
    if (!state) return;
    state.autoSpeak = autoSpeak.checked;
    if (state.autoSpeak) speechController?.speakCurrent();
    else speechController?.stop();
  });
  mustElement<HTMLButtonElement>("#nextButton").addEventListener("click", () => {
    if (!state || state.submitting || state.transitioning || state.pendingAttempt) return;
    const value = answer.value.trim();
    if (!value) nextItem();
    else void submitAnswer(value, true);
  });
  mustElement<HTMLButtonElement>("#resetButton").addEventListener("click", () => { void rebuildPool(); });
  mustElement<HTMLButtonElement>("#retrySyncButton").addEventListener("click", () => {
    if (state?.contentRefreshRequired) void refreshContentAfterConflict();
    else if (state?.pendingAttempt) void sendPendingAttempt();
    else if (!state?.session) void startPracticeSession();
    else clearSyncProblem();
  });
  mustElement<HTMLButtonElement>("#refreshMistakesButton").addEventListener("click", () => { void refreshMistakes(); });
  mustElement<HTMLButtonElement>("#dismissLegacyButton").addEventListener("click", () => {
    mustElement<HTMLElement>("#legacyBanner").hidden = true;
  });
  mustElement<HTMLButtonElement>("#importLegacyButton").addEventListener("click", (event) => {
    void importLegacyMistakes(event.currentTarget as HTMLButtonElement);
  });
  if (state) accountSecurity = bindAccountSecurity(state.context);

  autoSpeak.disabled = !speechController?.supported;
  window.addEventListener("online", onOnline);
  window.addEventListener("offline", onOffline);
  window.addEventListener("beforeunload", onBeforeUnload);
}

function onOnline(): void {
  if (state?.membershipBlocked) return;
  if (state?.contentRefreshRequired) setSyncProblem("网络已恢复，请重新加载题库。", "重新加载题库");
  else if (state?.pendingAttempt || state?.pendingSessionStart) setSyncProblem("网络已恢复，请点击“重试同步”。");
  else if (state?.session) clearSyncProblem();
}

function onOffline(): void {
  if (state?.membershipBlocked) return;
  if (state?.contentRefreshRequired) {
    setSyncProblem("网络已断开。恢复网络后，请重新加载题库。", "重新加载题库");
  } else {
    setSyncProblem("网络已断开。未同步答题仅保留在当前页面，请恢复网络并重试后再离开。");
  }
}

function normaliseLifetime(raw: Record<string, unknown>): PracticeState["lifetime"] {
  const totals = raw.totals && typeof raw.totals === "object" && !Array.isArray(raw.totals)
    ? raw.totals as Record<string, unknown>
    : raw;
  const read = (key: string): number => typeof totals[key] === "number" ? totals[key] as number : 0;
  return {
    sessions: read("sessions"),
    attempts: read("attempts"),
    correct: read("correct"),
    accuracy: read("accuracy"),
    bestStreak: read("bestStreak"),
    durationMs: read("durationMs")
  };
}

export async function renderPractice(context: PageContext): Promise<void> {
  disposePractice();
  const generation = renderGeneration;
  context.renderShell(`
    <div class="page-title"><div><h1>英语打字练习</h1><p>正在读取练习内容和个人记录…</p></div></div>
    <section class="panel"><div class="panel-body"><div class="spinner" aria-hidden="true"></div><p class="muted">正在同步账号数据…</p></div></section>
  `, "/practice");

  try {
    let membership: Awaited<ReturnType<typeof api.membership>> | null = null;
    if (context.capabilities.membershipEnabled) {
      membership = await api.membership();
      if (generation !== renderGeneration) return;
      if (!membership.access.canPractice) { context.navigate("/membership", true); return; }
    }
    const importBatchId = practiceBatchId(location.search);
    const [content, mistakes, rawSummary] = await Promise.all([loadPracticeContent(importBatchId), api.mistakes(), api.summary()]);
    if (generation !== renderGeneration) return;
    const sorted = arrangePracticeContent(content, importBatchId);
    const sortedCategories = sorted.categories;
    const sortedItems = sorted.items;
    const legacyKeys = parseLegacyMistakes(localStorage.getItem("basicTypingMistakes"));
    const wordCount = sortedItems.filter((item) => item.kind === "word").length;
    const sentenceCount = sortedItems.filter((item) => item.kind === "sentence").length;
    state = {
      context,
      importBatchId,
      batch: "batch" in content ? content.batch : undefined,
      unavailableCount: "batch" in content ? content.unavailableCount : 0,
      categories: sortedCategories,
      items: sortedItems,
      mistakes: mistakesInScope(mistakes.items ?? [], sortedItems, importBatchId),
      mistakeIds: new Set(mistakesInScope(mistakes.items ?? [], sortedItems, importBatchId).map((record) => record.item.id)),
      pool: [],
      index: 0,
      categoryId: "all",
      mode: "order",
      session: null,
      sessionStartedAtMs: Date.now(),
      itemStartedAtMs: Date.now(),
      summary: {},
      lifetime: normaliseLifetime(rawSummary),
      localDone: 0,
      localCorrect: 0,
      localStreak: 0,
      currentHadWrongAttempt: false,
      submitting: false,
      transitioning: false,
      pendingAttempt: null,
      pendingSessionStart: false,
      rebuilding: false,
      contentRefreshing: false,
      mistakeRefreshSequence: 0,
      contentRefreshRequired: false,
      showEnglish: true,
      autoSpeak: false,
      legacyKeys,
      disposed: false,
      membershipBlocked: false,
      resumeTransition: null
    };
    context.renderShell(practiceMarkup(
      sortedCategories,
      wordCount,
      sentenceCount,
      legacyKeys.length > 0,
      context.user,
      context.capabilities.emailAuthEnabled,
      state.batch,
      state.unavailableCount
    ), "/practice");
    mustElement<HTMLElement>("#legacyCount").textContent = String(legacyKeys.length);
    layoutController = createPracticeLayout();
    const activeState = state;
    alignmentController = createPracticeAlignment({ isActive: () => isActive(activeState), onDataReady: renderPrompt });
    writingController = createWritingPreview({ isActive: () => isActive(activeState), onDataReady: renderPrompt });
    speechController = createSpeechController({
      speakButton: mustElement<HTMLButtonElement>("#speakButton"),
      isActive: () => isActive(activeState) && !activeState.membershipBlocked,
      getText: () => currentItem()?.english ?? null,
      autoEnabled: () => Boolean(state?.autoSpeak && state.session)
    });
    bindPracticeEvents();
    if (membership) {
      ensureMembershipNotice();
      document.querySelector("#practiceMembershipText")!.textContent = membershipLabel(membership);
      membershipTimer = window.setInterval(() => { if (document.visibilityState !== "hidden") void checkMembership(); }, 30_000);
    }
    renderMistakes();
    await rebuildPool();
  } catch (error) {
    if (generation !== renderGeneration) return;
    disposePractice();
    if (error instanceof ApiError && error.code === "MEMBERSHIP_REQUIRED") { context.navigate("/membership", true); return; }
    if (context.handleAuthError(error)) return;
    const batchError = new URLSearchParams(location.search).has("batch");
    context.renderShell(errorMarkup(batchError ? "本次文件练习不可用" : "练习内容读取失败", getErrorMessage(error))
      + (batchError ? `<button class="btn" id="exitImportBatchButton" type="button">退出本次文件练习</button>` : ""), "/practice");
    document.querySelector<HTMLButtonElement>("#exitImportBatchButton")?.addEventListener("click", () => context.navigate("/practice"));
    mustElement<HTMLButtonElement>("#retryButton").addEventListener("click", () => { void renderPractice(context); });
  }
}

export function disposePractice(): void {
  renderGeneration += 1;
  window.clearInterval(membershipTimer);
  membershipTimer = undefined;
  accountSecurity?.destroy();
  accountSecurity = null;
  layoutController?.destroy();
  layoutController = null;
  if (!state) return;
  state.disposed = true;
  window.removeEventListener("online", onOnline);
  window.removeEventListener("offline", onOffline);
  window.removeEventListener("beforeunload", onBeforeUnload);
  speechController?.destroy();
  speechController = null;
  alignmentController?.destroy();
  alignmentController = null;
  writingController?.destroy();
  writingController = null;
  if (state.session && !state.pendingAttempt) {
    const sessionId = state.session.id;
    const durationMs = Math.min(86_400_000, Math.max(0, Date.now() - state.sessionStartedAtMs));
    void api.finishPracticeSession(sessionId, durationMs).catch(() => undefined);
  }
  state = null;
}

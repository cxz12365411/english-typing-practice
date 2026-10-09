import { api, ApiError } from "./api";
import type { ContentCategory, ContentKind, MarkdownImportGroup, MarkdownImportMapping, MarkdownImportPreview, PageContext } from "./types";
import { mustElement, setBusy, showToast } from "./ui";
import { escapeHtml, getErrorMessage } from "./utils";

const MAX_BYTES = 1024 * 1024;
const PAGE_SIZE = 100;

export interface MarkdownImportState {
  markdown: string;
  fileName: string;
  defaultCategoryName: string;
  mappings: MarkdownImportMapping[];
  groups: MarkdownImportGroup[];
  preview: MarkdownImportPreview | null;
  page: number;
  version: number;
  expiryTimer: number | null;
}

export function createMarkdownImportState(): MarkdownImportState {
  return { markdown: "", fileName: "", defaultCategoryName: "", mappings: [], groups: [], preview: null, page: 0, version: 0, expiryTimer: null };
}

export function disposeMarkdownImport(model: MarkdownImportState): void {
  ++model.version;
  if (model.expiryTimer !== null) window.clearTimeout(model.expiryTimer);
  model.expiryTimer = null;
}

export function markdownImportMarkup(model: MarkdownImportState): string {
  return `<section class="markdown-import admin-section">
    <section class="panel">
      <div class="panel-heading"><h2>导入 Markdown</h2><a class="btn small" href="/markdown-template.md" download="题库导入模板.md">下载 MD 模板</a></div>
      <div class="panel-body">
        <form class="form-stack" id="markdownPreviewForm">
          <p class="muted">粘贴或上传包含英文、中文释义、中文谐音的文件。二级标题作为分类；不会自动翻译或生成谐音，也不会覆盖旧题。</p>
          <div class="markdown-drop-zone" id="markdownDropZone">
            <label class="field"><span>选择 Markdown 文件，或拖入这里</span><input class="input" id="markdownFileInput" type="file" accept=".md,.markdown,text/markdown"></label>
            <span class="helper">每次一个 UTF-8 文件，最大 1 MiB、5000 条；选择文件后自动预览。</span>
            <span class="helper" id="markdownFileName">${escapeHtml(model.fileName || "尚未选择文件，可直接在下面粘贴内容")}</span>
          </div>
          <label class="field"><span>没有标题时使用的分类名称</span><input class="input" id="markdownDefaultCategory" maxlength="100" value="${escapeHtml(model.defaultCategoryName)}" placeholder="例如：旅行交流（无标题且无文件名时必填）"></label>
          <label class="field"><span>Markdown 内容</span><textarea class="textarea markdown-source" id="markdownText" rows="12" required placeholder="## 街头摄影&#10;| 英文 | 中文释义 | 中文谐音 |&#10;| --- | --- | --- |&#10;| May I take your photo? | 我可以给你拍张照吗？ | 梅 爱 泰克 尤尔 佛托？ |">${escapeHtml(model.markdown)}</textarea></label>
          <button class="btn primary" id="previewMarkdownButton" type="submit">重新校验并预览</button>
        </form>
      </div>
    </section>
    <section class="panel"><div class="panel-heading"><h2>分类与类型映射</h2></div><div class="panel-body" id="markdownMappingContent"></div></section>
    <section class="panel"><div class="panel-heading"><h2>导入预览</h2></div><div class="panel-body form-stack" id="markdownPreviewContent" aria-live="polite"></div></section>
  </section>`;
}

function categoryStatus(category: ContentCategory): string {
  return category.status === "published" ? "已发布" : category.status === "archived" ? "已下架" : "草稿";
}

function mappingMarkup(model: MarkdownImportState, categories: ContentCategory[]): string {
  if (!model.groups.length) return '<p class="helper">解析后将在这里显示文件分类，可改为已有分类或新建分类。</p>';
  return `<p class="helper">修改分类或类型后，请重新校验。已有草稿和下架分类不会自动发布。</p>
    <div class="markdown-mappings">${model.groups.map((group) => {
      const mapping = model.mappings.find((entry) => entry.groupId === group.groupId);
      const selected = mapping?.categoryId ?? (mapping?.name !== undefined ? "__new__" : group.categoryId ?? (group.action === "ambiguous" ? "" : "__new__"));
      const name = mapping?.name ?? group.name;
      const kind = mapping?.kind ?? group.kind;
      return `<div class="markdown-mapping" data-md-group="${escapeHtml(group.groupId)}">
        <strong>${escapeHtml(group.title || group.name)} <span class="helper">第 ${group.row} 行 · ${group.action === "create" ? "待新建" : group.action === "ambiguous" ? "存在多个匹配，请手选" : "已有分类"}</span></strong>
        <label class="field"><span>目标分类</span><select class="select" data-md-field="categoryId">
          ${!selected ? '<option value="">请选择匹配分类</option>' : ""}
          <option value="__new__"${selected === "__new__" ? " selected" : ""}>新建分类</option>
          ${categories.map((category) => `<option value="${escapeHtml(category.id)}"${category.id === selected ? " selected" : ""}>${escapeHtml(category.name)}（${category.kind === "word" ? "单词" : "句型"} · ${categoryStatus(category)}）</option>`).join("")}
        </select></label>
        <label class="field"><span>新分类名称</span><input class="input" data-md-field="name" maxlength="100" value="${escapeHtml(name)}"${selected !== "__new__" ? " disabled" : ""}></label>
        <label class="field"><span>类型</span><select class="select" data-md-field="kind"${selected !== "__new__" ? " disabled" : ""}><option value="word"${kind === "word" ? " selected" : ""}>单词</option><option value="sentence"${kind === "sentence" ? " selected" : ""}>句型</option></select></label>
      </div>`;
    }).join("")}</div>`;
}

const actionLabels = { create: "新增", reuse: "复用已有题", unavailable: "不可练习", duplicate: "文件内重复，跳过" };

function previewMarkup(model: MarkdownImportState, notice = ""): string {
  const preview = model.preview;
  if (!preview) return `<div class="empty-state">${escapeHtml(notice || "上传或粘贴 Markdown 后自动预览，也可点击重新校验。整批无错误后才能发布。")}</div>`;
  const expired = new Date(preview.expiresAt).getTime() <= Date.now();
  const invalid = preview.errors.length > 0 || preview.groups.some((group) => group.action === "ambiguous");
  const { summary } = preview;
  const start = model.page * PAGE_SIZE;
  const rows = preview.rows.slice(start, start + PAGE_SIZE);
  const pages = Math.max(1, Math.ceil(preview.rows.length / PAGE_SIZE));
  return `
    <div class="message ${invalid ? "error" : expired ? "warning" : "success"}">${invalid ? `发现 ${preview.errors.length} 个错误，请修正后重新校验。` : expired ? "预览已过期，请重新校验。" : `校验完成，本次可以练习 ${summary.practiceCount} 道题。`}</div>
    <p class="markdown-summary">共 ${summary.total} 条 · 新增 ${summary.created} · 复用 ${summary.reused} · 不可练习 ${summary.unavailable} · 文件内重复 ${summary.duplicates} · 忽略说明行 ${summary.ignoredCount}</p>
    <p class="helper">预览有效期 30 分钟；现有题目的释义、谐音和学习记录保持不变。</p>
    ${preview.errors.length ? `<details class="markdown-issues" open><summary>错误（${preview.errors.length}）</summary><ul>${preview.errors.map((issue) => `<li>第 ${issue.row} 行${issue.field ? `（${escapeHtml(issue.field)}）` : ""}：${escapeHtml(issue.message)}</li>`).join("")}</ul></details>` : ""}
    ${preview.warnings.length ? `<details class="markdown-issues"><summary>提示（${preview.warnings.length}）</summary><ul>${preview.warnings.map((issue) => `<li>第 ${issue.row} 行：${escapeHtml(issue.message)}</li>`).join("")}</ul></details>` : ""}
    <div class="inline-actions markdown-pagination">
      <span>显示 ${preview.rows.length ? start + 1 : 0}–${start + rows.length} / ${preview.rows.length} 条 · 第 ${model.page + 1} / ${pages} 页</span>
      <button class="btn small" data-md-page="previous" type="button"${model.page === 0 ? " disabled" : ""}>上一页</button>
      <button class="btn small" data-md-page="next" type="button"${model.page + 1 >= pages ? " disabled" : ""}>下一页</button>
    </div>
    <div class="table-wrap"><table class="data-table markdown-preview-table"><thead><tr><th>源行号</th><th>分类</th><th>类型</th><th>英文</th><th>中文释义</th><th>中文谐音</th><th>状态</th></tr></thead><tbody>${rows.map((row) => `<tr><td>${row.row}</td><td>${escapeHtml(row.categoryName)}</td><td>${row.kind === "word" ? "单词" : "句型"}</td><td>${escapeHtml(row.english)}</td><td>${escapeHtml(row.meaning)}</td><td>${escapeHtml(row.pronunciation || "未提供")}</td><td>${actionLabels[row.action]}${row.message ? `<br><span class="helper">${escapeHtml(row.message)}</span>` : ""}</td></tr>`).join("")}</tbody></table></div>
    ${summary.practiceCount === 0 ? '<p class="message warning">本次没有可练习的题目，不会创建空分类或空批次。</p>' : ""}
    <button class="btn primary" id="commitMarkdownImportButton" type="button"${invalid || expired || !preview.previewId || summary.practiceCount === 0 ? " disabled" : ""}>导入并发布，开始练习</button>`;
}

export function bindMarkdownImport(model: MarkdownImportState, categories: ContentCategory[], context: PageContext, isCurrent: () => boolean): void {
  const form = mustElement<HTMLFormElement>("#markdownPreviewForm");
  const source = mustElement<HTMLTextAreaElement>("#markdownText");
  const fallback = mustElement<HTMLInputElement>("#markdownDefaultCategory");
  const fileInput = mustElement<HTMLInputElement>("#markdownFileInput");
  const dropZone = mustElement<HTMLElement>("#markdownDropZone");
  const mappingsElement = mustElement<HTMLElement>("#markdownMappingContent");
  const output = mustElement<HTMLElement>("#markdownPreviewContent");
  const previewButton = mustElement<HTMLButtonElement>("#previewMarkdownButton");
  let previewBusy = false;
  let commitBusy = false;
  let revalidateAfterPending = false;

  const syncEditor = (): void => {
    model.markdown = source.value;
    model.defaultCategoryName = fallback.value;
  };
  const clearExpiry = (): void => {
    if (model.expiryTimer !== null) window.clearTimeout(model.expiryTimer);
    model.expiryTimer = null;
  };

  const renderOutput = (notice = ""): void => {
    if (!isCurrent()) return;
    clearExpiry();
    output.innerHTML = previewMarkup(model, notice);
    output.querySelectorAll<HTMLButtonElement>("[data-md-page]").forEach((button) => {
      button.addEventListener("click", () => {
        if (!isCurrent() || button.disabled || !model.preview || commitBusy) return;
        model.page += button.dataset.mdPage === "next" ? 1 : -1;
        renderOutput();
      });
    });
    const commitButton = output.querySelector<HTMLButtonElement>("#commitMarkdownImportButton");
    if (commitButton) {
      if (commitBusy) setBusy(commitButton, true, "正在导入…");
      commitButton.addEventListener("click", () => { void commit(); });
    }
    if (model.preview) {
      const delay = new Date(model.preview.expiresAt).getTime() - Date.now();
      if (delay > 0 && Number.isFinite(delay)) {
        model.expiryTimer = window.setTimeout(() => { if (isCurrent()) renderOutput(); }, Math.min(delay + 50, 2147483647));
      }
    }
  };

  const invalidate = (resetGroups = false): void => {
    ++model.version;
    revalidateAfterPending = false;
    model.preview = null;
    model.page = 0;
    if (resetGroups) {
      model.groups = [];
      model.mappings = [];
      renderMappings();
    }
    renderOutput("内容或分类已修改，请重新校验后再提交。");
  };

  const collectMappings = (): void => {
    model.mappings = [...mappingsElement.querySelectorAll<HTMLElement>("[data-md-group]")].flatMap<MarkdownImportMapping>((row) => {
      const groupId = row.dataset.mdGroup ?? "";
      const selected = mustElement<HTMLSelectElement>('[data-md-field="categoryId"]', row).value;
      if (!selected) return [];
      if (selected !== "__new__") return [{ groupId, categoryId: selected }];
      return [{ groupId, name: mustElement<HTMLInputElement>('[data-md-field="name"]', row).value.trim(), kind: mustElement<HTMLSelectElement>('[data-md-field="kind"]', row).value as ContentKind }];
    });
  };

  function renderMappings(): void {
    if (!isCurrent()) return;
    mappingsElement.innerHTML = mappingMarkup(model, categories);
    mappingsElement.querySelectorAll<HTMLInputElement | HTMLSelectElement>("[data-md-field]").forEach((input) => {
      input.addEventListener(input instanceof HTMLInputElement ? "input" : "change", () => {
        if (!isCurrent() || commitBusy) return;
        const row = input.closest<HTMLElement>("[data-md-group]");
        if (row && input.dataset.mdField === "categoryId") {
          const selected = (input as HTMLSelectElement).value;
          const name = mustElement<HTMLInputElement>('[data-md-field="name"]', row);
          const kind = mustElement<HTMLSelectElement>('[data-md-field="kind"]', row);
          name.disabled = selected !== "__new__";
          kind.disabled = selected !== "__new__";
          const category = categories.find((entry) => entry.id === selected);
          if (category) { name.value = category.name; kind.value = category.kind; }
        }
        collectMappings();
        invalidate();
      });
    });
  }

  const setEditorBusy = (busy: boolean): void => {
    form.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLButtonElement>("input, textarea, button").forEach((element) => { element.disabled = busy; });
    mappingsElement.querySelectorAll<HTMLInputElement | HTMLSelectElement>("input, select").forEach((element) => { element.disabled = busy; });
    if (!busy) renderMappings();
  };

  async function validate(): Promise<void> {
    if (!isCurrent() || commitBusy) return;
    if (previewBusy) { revalidateAfterPending = true; return; }
    syncEditor();
    const version = ++model.version;
    model.preview = null;
    renderOutput("正在校验 Markdown…");
    if (!model.markdown.trim() || new TextEncoder().encode(model.markdown).byteLength > MAX_BYTES || /\u0000|\uFFFD/.test(model.markdown)) {
      renderOutput(!model.markdown.trim() ? "请先上传或粘贴 Markdown。" : "内容必须是有效 UTF-8 文本，且不超过 1 MiB。请检查文件编码和大小。");
      return;
    }
    previewBusy = true;
    setBusy(previewButton, true, "正在校验…");
    try {
      const preview = await api.previewMarkdownImport({ markdown: model.markdown, ...(model.fileName ? { fileName: model.fileName } : {}), ...(model.defaultCategoryName.trim() ? { defaultCategoryName: model.defaultCategoryName.trim() } : {}), mappings: model.mappings });
      if (!isCurrent() || version !== model.version) return;
      model.preview = preview;
      model.groups = preview.groups;
      model.page = 0;
      renderMappings();
      renderOutput();
    } catch (error) {
      if (!isCurrent() || version !== model.version) return;
      if (!context.handleAuthError(error)) renderOutput(getErrorMessage(error, "Markdown 校验失败，请重试。"));
    } finally {
      previewBusy = false;
      if (isCurrent()) setBusy(previewButton, false);
      if (isCurrent() && revalidateAfterPending) {
        revalidateAfterPending = false;
        void validate();
      }
    }
  }

  async function commit(): Promise<void> {
    const preview = model.preview;
    if (!isCurrent() || commitBusy || previewBusy || !preview || preview.errors.length || preview.groups.some((group) => group.action === "ambiguous") || !preview.summary.practiceCount || new Date(preview.expiresAt).getTime() <= Date.now()) return;
    commitBusy = true;
    setEditorBusy(true);
    renderOutput();
    try {
      const result = await api.commitMarkdownImport(preview.previewId);
      if (!isCurrent() || model.preview !== preview) return;
      model.preview = null;
      showToast(`已发布 ${result.created} 条，复用 ${result.reused} 条，开始练习本次文件`, "success");
      context.navigate(`/practice?batch=${encodeURIComponent(result.batchId)}`);
    } catch (error) {
      if (!isCurrent() || model.preview !== preview) return;
      if (context.handleAuthError(error)) return;
      if (error instanceof ApiError && error.status === 409) {
        invalidate();
        showToast(getErrorMessage(error, "预览内容已变化，请重新校验。"), "error");
      } else {
        // Preserve the same server preview ID after a lost response; retry is idempotent.
        showToast(`${getErrorMessage(error, "导入结果尚未确认。")} 可点击同一按钮重试，不会重复导入。`, "error", 8000);
      }
    } finally {
      commitBusy = false;
      if (isCurrent()) {
        setEditorBusy(false);
        renderOutput();
      }
    }
  }

  async function loadFile(files: FileList | File[] | null): Promise<void> {
    if (!isCurrent() || commitBusy) return;
    invalidate(true);
    const version = model.version;
    if (!files || files.length !== 1) { renderOutput("每次请选择或拖入一个 Markdown 文件。"); return; }
    const file = files[0];
    if (!/\.(md|markdown)$/i.test(file.name) || file.size > MAX_BYTES) {
      renderOutput("请选择 .md 或 .markdown 文件，大小不能超过 1 MiB。");
      return;
    }
    try {
      const bytes = await file.arrayBuffer();
      if (!isCurrent() || version !== model.version) return;
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      model.markdown = text;
      model.fileName = file.name;
      source.value = text;
      mustElement<HTMLElement>("#markdownFileName").textContent = file.name;
      await validate();
    } catch (error) {
      if (!isCurrent() || version !== model.version) return;
      renderOutput(error instanceof TypeError ? "文件不是有效的 UTF-8 编码，请另存为 UTF-8 后重新上传。" : "Markdown 文件读取失败，请重试。");
    } finally {
      if (isCurrent()) fileInput.value = "";
    }
  }

  form.addEventListener("submit", (event) => { event.preventDefault(); void validate(); });
  source.addEventListener("input", () => { if (isCurrent() && !commitBusy) { syncEditor(); invalidate(true); } });
  fallback.addEventListener("input", () => { if (isCurrent() && !commitBusy) { syncEditor(); invalidate(true); } });
  source.addEventListener("paste", () => { window.setTimeout(() => { if (isCurrent()) void validate(); }, 0); });
  fileInput.addEventListener("change", () => { void loadFile(fileInput.files); });
  dropZone.addEventListener("dragover", (event) => { event.preventDefault(); if (!commitBusy) dropZone.classList.add("drag-over"); });
  dropZone.addEventListener("dragleave", () => { dropZone.classList.remove("drag-over"); });
  dropZone.addEventListener("drop", (event) => { event.preventDefault(); dropZone.classList.remove("drag-over"); void loadFile(event.dataTransfer?.files ?? null); });
  renderMappings();
  renderOutput();
}

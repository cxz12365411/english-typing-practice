import { api } from "./api";
import type {
  AdminStats,
  AuditRecord,
  ContentCategory,
  ContentItem,
  ContentKind,
  ImportPreviewResponse,
  PageContext,
  Role,
  User
} from "./types";
import { errorMarkup, mustElement, setBusy, showToast } from "./ui";
import { escapeHtml, formatDate, getErrorMessage, numberValue } from "./utils";

type AdminTab = "overview" | "users" | "content" | "import" | "audit";

interface AdminState {
  context: PageContext;
  tab: AdminTab;
  users: User[];
  categories: ContentCategory[];
  items: ContentItem[];
  stats: AdminStats;
  audit: AuditRecord[];
  editingItemId: string | null;
  contentSearch: string;
  importPreview: ImportPreviewResponse | null;
  temporaryPassword: { username: string; password: string } | null;
  disposed: boolean;
}

let state: AdminState | null = null;

const tabLabels: Record<AdminTab, string> = {
  overview: "概览",
  users: "用户管理",
  content: "题库管理",
  import: "CSV 导入",
  audit: "审计日志"
};

function statusOf(value: { status?: string; active?: boolean }): string {
  if (value.status) return value.status;
  return value.active === false ? "disabled" : "active";
}

function statsBranch(name: string): Record<string, unknown> {
  if (!state) return {};
  const branch = state.stats[name];
  return branch && typeof branch === "object" && !Array.isArray(branch)
    ? branch as Record<string, unknown>
    : {};
}

function branchNumber(branch: Record<string, unknown>, key: string, fallback = 0): number {
  const value = branch[key];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function adminFrame(body: string): string {
  if (!state) return "";
  const tabs = (Object.keys(tabLabels) as AdminTab[]).map((tab) => `
    <button class="admin-tab${state?.tab === tab ? " active" : ""}" type="button" data-admin-tab="${tab}">${tabLabels[tab]}</button>
  `).join("");
  return `
    <div class="page-title">
      <div><h1>管理后台</h1><p>管理账号、练习内容、发布状态和审计记录</p></div>
      <button class="btn" id="refreshAdminButton" type="button">刷新数据</button>
    </div>
    <nav class="admin-tabs" aria-label="管理栏目">${tabs}</nav>
    <div id="adminBody">${body}</div>
  `;
}

function statNumber(keys: string[], fallback = 0): number {
  if (!state) return fallback;
  for (const key of keys) {
    const value = state.stats[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return fallback;
}

function overviewMarkup(): string {
  if (!state) return "";
  const userStats = statsBranch("users");
  const practiceStats = statsBranch("practice");
  const contentStats = statsBranch("content");
  const users = branchNumber(userStats, "total", statNumber(["totalUsers"], state.users.length));
  const active = branchNumber(userStats, "active", statNumber(["activeUsers", "enabledUsers"], state.users.filter((user) => user.status === "active").length));
  const attempts = branchNumber(practiceStats, "attempts", statNumber(["totalAttempts", "attempts"]));
  const totalContent = branchNumber(contentStats, "total", state.items.length);
  const accuracyRaw = branchNumber(practiceStats, "accuracy", statNumber(["accuracy", "overallAccuracy"]));
  const accuracy = accuracyRaw > 0 && accuracyRaw <= 1 ? accuracyRaw * 100 : accuracyRaw;
  return `
    <section class="admin-section">
      <div class="admin-stats">
        <div class="panel admin-stat"><span>账号总数</span><strong>${Math.round(users)}</strong></div>
        <div class="panel admin-stat"><span>有效账号</span><strong>${Math.round(active)}</strong></div>
        <div class="panel admin-stat"><span>累计答题</span><strong>${Math.round(attempts)}</strong></div>
        <div class="panel admin-stat"><span>题目总数</span><strong>${Math.round(totalContent)}</strong></div>
      </div>
      <div class="admin-grid">
        <section class="panel">
          <div class="panel-heading"><h2>学习概况</h2></div>
          <div class="panel-body form-stack">
            <div><span class="muted">整体正确率</span><div class="preview-english">${Math.round(accuracy)}%</div></div>
            <div><span class="muted">已发布内容</span><div class="preview-english">${branchNumber(contentStats, "words") + branchNumber(contentStats, "sentences", state.items.filter((item) => statusOf(item) === "published").length)}</div></div>
            <p class="muted">统计数据来自服务端，不包含用户输入的错误答案文本。</p>
          </div>
        </section>
        <section class="panel">
          <div class="panel-heading"><h2>最近登录</h2></div>
          <div class="table-wrap">
            <table class="data-table">
              <thead><tr><th>用户</th><th>角色</th><th>状态</th><th>最近登录</th></tr></thead>
              <tbody>
                ${[...state.users].sort((a, b) => String(b.lastLoginAt ?? "").localeCompare(String(a.lastLoginAt ?? ""))).slice(0, 8).map((user) => `
                  <tr>
                    <td><strong>${escapeHtml(user.displayName || user.username)}</strong><br><span class="muted">${escapeHtml(user.username)}</span></td>
                    <td>${user.role === "admin" ? "管理员" : "学员"}</td>
                    <td><span class="status-pill ${statusOf(user)}">${statusOf(user) === "active" ? "有效" : "停用"}</span></td>
                    <td>${escapeHtml(formatDate(user.lastLoginAt))}</td>
                  </tr>
                `).join("") || `<tr><td colspan="4"><div class="empty-state">暂无用户数据</div></td></tr>`}
              </tbody>
            </table>
          </div>
        </section>
      </div>
    </section>
  `;
}

function temporaryPasswordMarkup(): string {
  if (!state?.temporaryPassword) return "";
  return `
    <div class="message warning temporary-password" id="temporaryPasswordBox">
      <strong>${escapeHtml(state.temporaryPassword.username)} 的一次性临时密码</strong>
      <code id="temporaryPasswordValue">${escapeHtml(state.temporaryPassword.password)}</code>
      <div class="inline-actions">
        <button class="btn small" id="copyTemporaryPasswordButton" type="button">复制密码</button>
        <button class="btn ghost small" id="hideTemporaryPasswordButton" type="button">我已保存</button>
      </div>
      <span class="helper">该密码仅显示在当前页面，请安全发送给用户；用户首次登录后必须修改。</span>
    </div>
  `;
}

function usersMarkup(): string {
  if (!state) return "";
  const currentUserId = state.context.user.id;
  return `
    <section class="admin-grid">
      <section class="panel">
        <div class="panel-heading"><h2>创建账号</h2></div>
        <div class="panel-body">
          <form class="form-stack" id="createUserForm">
            <label class="field"><span>登录账号</span><input class="input" name="username" autocomplete="off" minlength="3" maxlength="32" pattern="[A-Za-z0-9._-]+" required><span class="helper">使用字母、数字、点、下划线或短横线。</span></label>
            <label class="field"><span>显示名称</span><input class="input" name="displayName" maxlength="80" required></label>
            <label class="field"><span>角色</span><select class="select" name="role"><option value="user">学员</option><option value="admin">管理员</option></select></label>
            <button class="btn primary" type="submit">创建并生成临时密码</button>
          </form>
          ${temporaryPasswordMarkup()}
        </div>
      </section>

      <section class="panel">
        <div class="panel-heading"><h2>账号列表</h2><span class="muted">${state.users.length} 个账号</span></div>
        <div class="table-wrap">
          <table class="data-table">
            <thead><tr><th>账号</th><th>邮箱</th><th>显示名称</th><th>角色</th><th>状态</th><th>首次改密</th><th>操作</th></tr></thead>
            <tbody>
              ${state.users.map((user) => `
                <tr data-user-row="${escapeHtml(user.id)}">
                  <td><strong>${escapeHtml(user.username)}</strong><br><span class="muted">${escapeHtml(formatDate(user.lastLoginAt))}</span></td>
                  <td>${user.emailVerified && user.email ? `<span>${escapeHtml(user.email)}</span><br><span class="status-pill active">已验证</span>` : `<span class="muted">未绑定</span>`}</td>
                  <td><input class="input" data-user-field="displayName" value="${escapeHtml(user.displayName)}" maxlength="80" aria-label="${escapeHtml(user.username)} 的显示名称"></td>
                  <td>
                    <select class="select" data-user-field="role" aria-label="${escapeHtml(user.username)} 的角色">
                      <option value="user"${user.role === "user" ? " selected" : ""}>学员</option>
                      <option value="admin"${user.role === "admin" ? " selected" : ""}>管理员</option>
                    </select>
                  </td>
                  <td>
                    <select class="select" data-user-field="status" aria-label="${escapeHtml(user.username)} 的状态">
                      <option value="active"${statusOf(user) === "active" ? " selected" : ""}>有效</option>
                      <option value="disabled"${statusOf(user) === "disabled" ? " selected" : ""}>停用</option>
                    </select>
                  </td>
                  <td>${user.mustChangePassword ? "是" : "否"}</td>
                  <td>
                    <div class="inline-actions">
                      <button class="btn small" type="button" data-user-action="save" data-id="${escapeHtml(user.id)}">保存</button>
                      ${user.id !== currentUserId ? `<button class="btn small" type="button" data-user-action="reset" data-id="${escapeHtml(user.id)}">重置密码</button>` : ""}
                      <button class="btn ghost small" type="button" data-user-action="revoke" data-id="${escapeHtml(user.id)}">撤销会话</button>
                    </div>
                  </td>
                </tr>
              `).join("") || `<tr><td colspan="7"><div class="empty-state">暂无账号</div></td></tr>`}
            </tbody>
          </table>
        </div>
      </section>
    </section>
  `;
}

function categoryOptions(selectedId?: string): string {
  if (!state) return "";
  return [...state.categories]
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .map((category) => `<option value="${escapeHtml(category.id)}"${category.id === selectedId ? " selected" : ""}>${escapeHtml(category.name)}</option>`)
    .join("");
}

function itemFormMarkup(): string {
  if (!state) return "";
  const item = state.editingItemId ? state.items.find((entry) => entry.id === state?.editingItemId) : undefined;
  const categoryId = item?.categoryId ?? state.categories[0]?.id ?? "";
  return `
    <form class="form-stack" id="itemForm">
      <input type="hidden" name="id" value="${escapeHtml(item?.id ?? "")}">
      <label class="field"><span>唯一键（可选）</span><input class="input" name="key" value="${escapeHtml(item?.key ?? "")}" maxlength="100"></label>
      <label class="field"><span>分类</span><select class="select" name="categoryId" required>${categoryOptions(categoryId)}</select></label>
      <label class="field"><span>类型</span><select class="select" name="kind"><option value="word"${item?.kind !== "sentence" ? " selected" : ""}>单词</option><option value="sentence"${item?.kind === "sentence" ? " selected" : ""}>句型</option></select></label>
      <label class="field"><span>英文答案</span><textarea class="textarea" name="english" maxlength="500" required>${escapeHtml(item?.english ?? "")}</textarea></label>
      <label class="field"><span>中文释义</span><textarea class="textarea" name="meaning" maxlength="1000" required>${escapeHtml(item?.meaning ?? "")}</textarea></label>
      <label class="field"><span>中文谐音（可选）</span><input class="input" name="pronunciation" value="${escapeHtml(item?.pronunciation ?? "")}" maxlength="500"></label>
      <label class="field"><span>排序</span><input class="input" name="sortOrder" type="number" min="0" step="1" value="${item?.sortOrder ?? state.items.length}"></label>
      <div class="preview-card" aria-label="题目预览">
        <span class="muted">实时预览</span>
        <div class="preview-english" id="itemPreviewEnglish">${escapeHtml(item?.english || "English")}</div>
        <div id="itemPreviewMeaning">${escapeHtml(item?.meaning || "中文释义")}</div>
        <div class="muted" id="itemPreviewPronunciation">${escapeHtml(item?.pronunciation || "中文谐音")}</div>
      </div>
      <div class="inline-actions">
        <button class="btn primary" type="submit">${item ? "保存草稿" : "创建草稿"}</button>
        ${item ? `<button class="btn" id="cancelEditItemButton" type="button">取消编辑</button>` : ""}
      </div>
    </form>
  `;
}

function contentRowsMarkup(): string {
  if (!state) return "";
  const query = state.contentSearch.trim().toLocaleLowerCase("zh-CN");
  const filtered = state.items.filter((item) => {
    if (!query) return true;
    return [item.english, item.meaning, item.key].some((value) => value.toLocaleLowerCase("zh-CN").includes(query));
  });
  const rows = filtered.slice(0, 300);
  const categoriesById = new Map(state.categories.map((category) => [category.id, category.name]));
  return `
    ${filtered.length > rows.length ? `<div class="message info">共匹配 ${filtered.length} 条，当前显示前 ${rows.length} 条。可用搜索缩小范围。</div>` : ""}
    <div class="table-wrap">
      <table class="data-table">
        <thead><tr><th>英文</th><th>释义</th><th>分类</th><th>类型</th><th>排序</th><th>状态</th><th>操作</th></tr></thead>
        <tbody>
          ${rows.map((item) => {
            const status = statusOf(item);
            const statusText = status === "published" ? "已发布" : status === "archived" ? "已下架" : "草稿";
            return `
              <tr>
                <td class="truncate" title="${escapeHtml(item.english)}"><strong>${escapeHtml(item.english)}</strong></td>
                <td class="truncate" title="${escapeHtml(item.meaning)}">${escapeHtml(item.meaning)}</td>
                <td>${escapeHtml(categoriesById.get(item.categoryId) ?? "未分类")}</td>
                <td>${item.kind === "sentence" ? "句型" : "单词"}</td>
                <td>${item.sortOrder}</td>
                <td><span class="status-pill ${escapeHtml(status)}">${statusText}</span></td>
                <td><div class="inline-actions">
                  <button class="btn small" type="button" data-item-action="edit" data-id="${escapeHtml(item.id)}">编辑</button>
                  ${status !== "published" ? `<button class="btn small" type="button" data-item-action="publish" data-id="${escapeHtml(item.id)}">发布</button>` : ""}
                  ${status !== "archived" ? `<button class="btn danger small" type="button" data-item-action="archive" data-id="${escapeHtml(item.id)}">下架</button>` : ""}
                </div></td>
              </tr>
            `;
          }).join("") || `<tr><td colspan="7"><div class="empty-state">没有匹配的题目</div></td></tr>`}
        </tbody>
      </table>
    </div>
  `;
}

function contentMarkup(): string {
  if (!state) return "";
  return `
    <section class="admin-section">
      <div class="admin-grid">
        <section class="panel">
          <div class="panel-heading"><h2>新建 / 编辑题目</h2></div>
          <div class="panel-body">${itemFormMarkup()}</div>
        </section>
        <section class="panel">
          <div class="panel-heading"><h2>分类与顺序</h2></div>
          <div class="panel-body form-stack">
            <form class="filters" id="createCategoryForm">
              <input class="input" name="slug" placeholder="分类标识，如 daily-word" pattern="[a-z0-9-]+" required>
              <input class="input" name="name" placeholder="分类名称" required>
              <select class="select" name="kind"><option value="word">单词</option><option value="sentence">句型</option></select>
              <input class="input" name="sortOrder" type="number" min="0" value="${state.categories.length}" aria-label="分类排序">
              <button class="btn primary" type="submit">新增分类</button>
            </form>
            <div class="table-wrap">
              <table class="data-table">
                <thead><tr><th>标识</th><th>名称</th><th>类型</th><th>排序</th><th>状态</th><th>操作</th></tr></thead>
                <tbody>
                  ${[...state.categories].sort((a, b) => a.sortOrder - b.sortOrder).map((category) => `
                    <tr data-category-row="${escapeHtml(category.id)}">
                      <td><input class="input" data-category-field="slug" value="${escapeHtml(category.slug ?? "")}" aria-label="分类标识"></td>
                      <td><input class="input" data-category-field="name" value="${escapeHtml(category.name)}" aria-label="分类名称"></td>
                      <td><select class="select" data-category-field="kind"><option value="word"${category.kind === "word" ? " selected" : ""}>单词</option><option value="sentence"${category.kind === "sentence" ? " selected" : ""}>句型</option></select></td>
                      <td><input class="input" data-category-field="sortOrder" type="number" min="0" value="${category.sortOrder}" aria-label="分类排序"></td>
                      <td><span class="status-pill ${escapeHtml(statusOf(category))}">${statusOf(category) === "published" ? "已发布" : statusOf(category) === "archived" ? "已下架" : "草稿"}</span></td>
                      <td><div class="inline-actions">
                        <button class="btn small" type="button" data-category-action="save" data-id="${escapeHtml(category.id)}">保存</button>
                        ${statusOf(category) !== "published" ? `<button class="btn small" type="button" data-category-action="publish" data-id="${escapeHtml(category.id)}">发布</button>` : ""}
                        ${statusOf(category) !== "archived" ? `<button class="btn danger small" type="button" data-category-action="archive" data-id="${escapeHtml(category.id)}">下架</button>` : ""}
                      </div></td>
                    </tr>
                  `).join("") || `<tr><td colspan="6"><div class="empty-state">暂无分类，请先创建。</div></td></tr>`}
                </tbody>
              </table>
            </div>
          </div>
        </section>
      </div>

      <section class="panel">
        <div class="panel-heading">
          <h2>题目列表</h2>
          <form class="filters" id="contentSearchForm">
            <input class="input content-search" name="query" value="${escapeHtml(state.contentSearch)}" placeholder="搜索英文、释义或唯一键">
            <button class="btn" type="submit">搜索</button>
            <button class="btn ghost" id="clearContentSearchButton" type="button">清除</button>
          </form>
        </div>
        <div class="panel-body">${contentRowsMarkup()}</div>
      </section>
    </section>
  `;
}

function previewValue(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function importMarkup(): string {
  if (!state) return "";
  const preview = state.importPreview;
  return `
    <section class="admin-grid">
      <section class="panel">
        <div class="panel-heading"><h2>导入 CSV</h2></div>
        <div class="panel-body">
          <form class="form-stack" id="csvPreviewForm">
            <p class="muted">使用 UTF-8 CSV。第一行为字段名，至少包含 categoryId、english、meaning；可选 kind、pronunciation、sortOrder、key、status。</p>
            <label class="field"><span>选择 CSV 文件</span><input class="input" id="csvFileInput" type="file" accept=".csv,text/csv"></label>
            <label class="field"><span>CSV 内容</span><textarea class="textarea" id="csvText" name="csv" rows="12" required placeholder="kind,category,english,meaning,pronunciation,sortOrder"></textarea></label>
            <button class="btn primary" type="submit">校验并预览</button>
          </form>
        </div>
      </section>
      <section class="panel">
        <div class="panel-heading"><h2>导入预览</h2></div>
        <div class="panel-body form-stack">
          ${preview ? `
            <div class="message ${preview.errors.length ? "error" : "success"}">
              ${preview.errors.length ? `发现 ${preview.errors.length} 个错误，修正后重新预览。` : `校验通过，共 ${preview.rows.length} 行，可提交导入。`}
            </div>
            <div class="json-details">摘要：${escapeHtml(JSON.stringify(preview.summary, null, 2))}</div>
            ${preview.errors.length ? `<div class="form-stack">${preview.errors.slice(0, 30).map((error) => `<div class="message error">${escapeHtml(typeof error === "string" ? error : `第 ${error.row ?? "?"} 行：${error.message ?? "格式错误"}`)}</div>`).join("")}</div>` : ""}
            <div class="table-wrap">
              <table class="data-table">
                <thead><tr><th>行</th><th>分类 ID</th><th>英文</th><th>释义</th><th>状态</th></tr></thead>
                <tbody>${preview.rows.slice(0, 100).map((row, index) => `<tr><td>${escapeHtml(row.row ?? index + 2)}</td><td>${escapeHtml(previewValue(row.categoryId ?? row.category))}</td><td>${escapeHtml(previewValue(row.english))}</td><td>${escapeHtml(previewValue(row.meaning))}</td><td>${escapeHtml(previewValue(row.status))}</td></tr>`).join("")}</tbody>
              </table>
            </div>
            <button class="btn primary" id="commitImportButton" type="button"${preview.errors.length ? " disabled" : ""}>提交整批导入</button>
          ` : `<div class="empty-state">上传或粘贴 CSV 后，先执行校验。只有整批无错误时才能提交，不会发生半批导入。</div>`}
        </div>
      </section>
    </section>
  `;
}

function auditMarkup(): string {
  if (!state) return "";
  return `
    <section class="panel">
      <div class="panel-heading"><h2>管理员操作记录</h2><span class="muted">最近 ${state.audit.length} 条</span></div>
      <div class="table-wrap">
        <table class="data-table">
          <thead><tr><th>时间</th><th>操作人</th><th>动作</th><th>对象</th><th>详情</th></tr></thead>
          <tbody>
            ${state.audit.map((entry) => `
              <tr>
                <td>${escapeHtml(formatDate(entry.createdAt))}</td>
                <td>${escapeHtml(entry.actorUsername ?? "系统")}</td>
                <td><strong>${escapeHtml(entry.action)}</strong></td>
                <td>${escapeHtml([entry.targetType, entry.targetId].filter(Boolean).join(" / ") || "—")}</td>
                <td><div class="json-details">${escapeHtml(entry.details || entry.metadata ? JSON.stringify(entry.details ?? entry.metadata) : "—")}</div></td>
              </tr>
            `).join("") || `<tr><td colspan="5"><div class="empty-state">暂无审计记录</div></td></tr>`}
          </tbody>
        </table>
      </div>
    </section>
  `;
}

function currentBodyMarkup(): string {
  if (!state) return "";
  switch (state.tab) {
    case "users": return usersMarkup();
    case "content": return contentMarkup();
    case "import": return importMarkup();
    case "audit": return auditMarkup();
    default: return overviewMarkup();
  }
}

function renderAdminView(): void {
  if (!state || state.disposed) return;
  state.context.renderShell(adminFrame(currentBodyMarkup()), "/admin");
  bindCommonEvents();
  if (state.tab === "users") bindUserEvents();
  if (state.tab === "content") bindContentEvents();
  if (state.tab === "import") bindImportEvents();
}

function bindCommonEvents(): void {
  document.querySelectorAll<HTMLButtonElement>("[data-admin-tab]").forEach((button) => {
    button.addEventListener("click", () => {
      if (!state) return;
      state.tab = button.dataset.adminTab as AdminTab;
      renderAdminView();
    });
  });
  mustElement<HTMLButtonElement>("#refreshAdminButton").addEventListener("click", () => {
    if (state) void reloadAdminData(state.context, true);
  });
}

async function reloadUsers(): Promise<void> {
  if (!state) return;
  const response = await api.adminUsers();
  state.users = response.users ?? [];
}

function bindTemporaryPasswordEvents(): void {
  document.querySelector<HTMLButtonElement>("#copyTemporaryPasswordButton")?.addEventListener("click", async () => {
    if (!state?.temporaryPassword) return;
    try {
      await navigator.clipboard.writeText(state.temporaryPassword.password);
      showToast("临时密码已复制", "success");
    } catch {
      showToast("无法自动复制，请手动选择密码文本", "error");
    }
  });
  document.querySelector<HTMLButtonElement>("#hideTemporaryPasswordButton")?.addEventListener("click", () => {
    if (!state) return;
    state.temporaryPassword = null;
    renderAdminView();
  });
}

function bindUserEvents(): void {
  bindTemporaryPasswordEvents();
  const createForm = mustElement<HTMLFormElement>("#createUserForm");
  createForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!state) return;
    const data = new FormData(createForm);
    const button = mustElement<HTMLButtonElement>('button[type="submit"]', createForm);
    setBusy(button, true, "正在创建…");
    try {
      const response = await api.createUser({
        username: String(data.get("username") ?? "").trim(),
        displayName: String(data.get("displayName") ?? "").trim(),
        role: String(data.get("role") ?? "user") as Role
      });
      state.temporaryPassword = {
        username: response.user.username,
        password: response.temporaryPassword ?? "服务器未返回临时密码"
      };
      await reloadUsers();
      renderAdminView();
      showToast("账号已创建", "success");
    } catch (error) {
      if (!state?.context.handleAuthError(error)) showToast(getErrorMessage(error, "账号创建失败"), "error");
      setBusy(button, false);
    }
  });

  document.querySelectorAll<HTMLButtonElement>("[data-user-action]").forEach((button) => {
    button.addEventListener("click", async () => {
      if (!state) return;
      const id = button.dataset.id ?? "";
      const action = button.dataset.userAction;
      const user = state.users.find((entry) => entry.id === id);
      if (!user) return;
      setBusy(button, true);
      try {
        if (action === "save") {
          const row = mustElement<HTMLTableRowElement>(`[data-user-row="${CSS.escape(id)}"]`);
          const displayName = mustElement<HTMLInputElement>('[data-user-field="displayName"]', row).value.trim();
          const role = mustElement<HTMLSelectElement>('[data-user-field="role"]', row).value as Role;
          const status = mustElement<HTMLSelectElement>('[data-user-field="status"]', row).value;
          if (status === "disabled" && user.status !== "disabled" && !window.confirm(`确定停用账号 ${user.username} 吗？其现有会话会失效。`)) {
            setBusy(button, false);
            return;
          }
          await api.updateUser(id, { displayName, role, active: status === "active" });
          showToast("账号资料已保存", "success");
        } else if (action === "reset") {
          const emailNotice = user.emailVerified && user.email ? "、清除已绑定邮箱" : "";
          if (!window.confirm(`重置 ${user.username} 的密码${emailNotice}并撤销其现有会话？`)) {
            setBusy(button, false);
            return;
          }
          const response = await api.resetPassword(id);
          state.temporaryPassword = {
            username: user.username,
            password: response.temporaryPassword ?? "服务器未返回临时密码"
          };
          showToast(user.emailVerified && user.email ? "密码已重置，原邮箱已解除绑定" : "密码已重置", "success");
        } else if (action === "revoke") {
          if (!window.confirm(`撤销 ${user.username} 的全部登录会话？`)) {
            setBusy(button, false);
            return;
          }
          await api.revokeSessions(id);
          showToast("登录会话已撤销", "success");
        }
        await reloadUsers();
        renderAdminView();
      } catch (error) {
        if (!state?.context.handleAuthError(error)) showToast(getErrorMessage(error), "error", 7000);
        setBusy(button, false);
      }
    });
  });
}

async function reloadContent(): Promise<void> {
  if (!state) return;
  const [categoryResponse, itemResponse] = await Promise.all([api.adminCategories(), api.adminItems()]);
  state.categories = categoryResponse.categories ?? [];
  state.items = itemResponse.items ?? [];
}

function bindItemPreview(form: HTMLFormElement): void {
  const update = (): void => {
    mustElement<HTMLElement>("#itemPreviewEnglish").textContent = mustElement<HTMLTextAreaElement>('[name="english"]', form).value || "English";
    mustElement<HTMLElement>("#itemPreviewMeaning").textContent = mustElement<HTMLTextAreaElement>('[name="meaning"]', form).value || "中文释义";
    mustElement<HTMLElement>("#itemPreviewPronunciation").textContent = mustElement<HTMLInputElement>('[name="pronunciation"]', form).value || "中文谐音";
  };
  form.addEventListener("input", update);
}

function bindContentEvents(): void {
  const categoryForm = mustElement<HTMLFormElement>("#createCategoryForm");
  categoryForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!state) return;
    const data = new FormData(categoryForm);
    const button = mustElement<HTMLButtonElement>('button[type="submit"]', categoryForm);
    setBusy(button, true, "正在创建…");
    try {
      await api.createCategory({
        slug: String(data.get("slug") ?? "").trim(),
        name: String(data.get("name") ?? "").trim(),
        kind: String(data.get("kind") ?? "word") as ContentKind,
        sortOrder: numberValue(data.get("sortOrder"), state.categories.length)
      });
      await reloadContent();
      renderAdminView();
      showToast("分类已创建", "success");
    } catch (error) {
      if (!state?.context.handleAuthError(error)) showToast(getErrorMessage(error, "分类创建失败"), "error");
      setBusy(button, false);
    }
  });

  document.querySelectorAll<HTMLButtonElement>("[data-category-action]").forEach((button) => {
    button.addEventListener("click", async () => {
      if (!state) return;
      const id = button.dataset.id ?? "";
      const action = button.dataset.categoryAction;
      setBusy(button, true);
      try {
        if (action === "save") {
          const row = mustElement<HTMLTableRowElement>(`[data-category-row="${CSS.escape(id)}"]`);
          await api.updateCategory(id, {
            slug: mustElement<HTMLInputElement>('[data-category-field="slug"]', row).value.trim(),
            name: mustElement<HTMLInputElement>('[data-category-field="name"]', row).value.trim(),
            kind: mustElement<HTMLSelectElement>('[data-category-field="kind"]', row).value as ContentKind,
            sortOrder: Number(mustElement<HTMLInputElement>('[data-category-field="sortOrder"]', row).value)
          });
        }
        if (action === "publish") await api.publishCategory(id);
        if (action === "archive") {
          if (!window.confirm("确定下架这个分类吗？分类中的内容将对学员隐藏，历史记录会保留。")) {
            setBusy(button, false);
            return;
          }
          await api.archiveCategory(id);
        }
        await reloadContent();
        renderAdminView();
        showToast(action === "publish" ? "分类已发布" : action === "archive" ? "分类已下架" : "分类已保存", "success");
      } catch (error) {
        if (!state?.context.handleAuthError(error)) showToast(getErrorMessage(error), "error");
        setBusy(button, false);
      }
    });
  });

  const itemForm = mustElement<HTMLFormElement>("#itemForm");
  bindItemPreview(itemForm);
  itemForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!state) return;
    const data = new FormData(itemForm);
    const id = String(data.get("id") ?? "");
    const key = String(data.get("key") ?? "").trim();
    const payload = {
      ...(key ? { key } : {}),
      categoryId: String(data.get("categoryId") ?? ""),
      kind: String(data.get("kind") ?? "word") as ContentKind,
      english: String(data.get("english") ?? "").trim(),
      meaning: String(data.get("meaning") ?? "").trim(),
      pronunciation: String(data.get("pronunciation") ?? "").trim(),
      sortOrder: numberValue(data.get("sortOrder"), state.items.length)
    };
    const button = mustElement<HTMLButtonElement>('button[type="submit"]', itemForm);
    setBusy(button, true, "正在保存…");
    try {
      if (id) await api.updateItem(id, payload);
      else await api.createItem(payload);
      state.editingItemId = null;
      await reloadContent();
      renderAdminView();
      showToast(id ? "题目已保存为草稿" : "草稿已创建", "success");
    } catch (error) {
      if (!state?.context.handleAuthError(error)) showToast(getErrorMessage(error, "题目保存失败"), "error");
      setBusy(button, false);
    }
  });
  document.querySelector<HTMLButtonElement>("#cancelEditItemButton")?.addEventListener("click", () => {
    if (!state) return;
    state.editingItemId = null;
    renderAdminView();
  });

  const searchForm = mustElement<HTMLFormElement>("#contentSearchForm");
  searchForm.addEventListener("submit", (event) => {
    event.preventDefault();
    if (!state) return;
    state.contentSearch = String(new FormData(searchForm).get("query") ?? "");
    renderAdminView();
  });
  mustElement<HTMLButtonElement>("#clearContentSearchButton").addEventListener("click", () => {
    if (!state) return;
    state.contentSearch = "";
    renderAdminView();
  });

  document.querySelectorAll<HTMLButtonElement>("[data-item-action]").forEach((button) => {
    button.addEventListener("click", async () => {
      if (!state) return;
      const id = button.dataset.id ?? "";
      const action = button.dataset.itemAction;
      if (action === "edit") {
        state.editingItemId = id;
        renderAdminView();
        mustElement<HTMLFormElement>("#itemForm").scrollIntoView({ behavior: "smooth", block: "start" });
        return;
      }
      if (action === "archive" && !window.confirm("确定下架这条内容吗？已有学习历史会保留。")) return;
      setBusy(button, true);
      try {
        if (action === "publish") await api.publishItem(id);
        if (action === "archive") await api.archiveItem(id);
        await reloadContent();
        renderAdminView();
        showToast(action === "publish" ? "内容已发布" : "内容已下架", "success");
      } catch (error) {
        if (!state?.context.handleAuthError(error)) showToast(getErrorMessage(error), "error");
        setBusy(button, false);
      }
    });
  });
}

function bindImportEvents(): void {
  const csvText = mustElement<HTMLTextAreaElement>("#csvText");
  mustElement<HTMLInputElement>("#csvFileInput").addEventListener("change", async (event) => {
    const file = (event.currentTarget as HTMLInputElement).files?.[0];
    if (!file) return;
    try {
      csvText.value = await file.text();
    } catch {
      showToast("CSV 文件读取失败", "error");
    }
  });
  const form = mustElement<HTMLFormElement>("#csvPreviewForm");
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!state) return;
    const button = mustElement<HTMLButtonElement>('button[type="submit"]', form);
    setBusy(button, true, "正在校验…");
    try {
      const raw = await api.previewImport(csvText.value);
      const preview = raw as ImportPreviewResponse & { previewId?: string };
      state.importPreview = {
        ...preview,
        importId: preview.importId || preview.previewId || "",
        rows: preview.rows ?? [],
        errors: preview.errors ?? [],
        summary: preview.summary ?? {}
      };
      renderAdminView();
    } catch (error) {
      if (!state?.context.handleAuthError(error)) showToast(getErrorMessage(error, "CSV 校验失败"), "error");
      setBusy(button, false);
    }
  });
  document.querySelector<HTMLButtonElement>("#commitImportButton")?.addEventListener("click", async (event) => {
    if (!state?.importPreview || state.importPreview.errors.length) return;
    if (!window.confirm(`确定导入这 ${state.importPreview.rows.length} 行内容吗？`)) return;
    const button = event.currentTarget as HTMLButtonElement;
    setBusy(button, true, "正在导入…");
    try {
      await api.commitImport(state.importPreview.importId);
      state.importPreview = null;
      await reloadContent();
      renderAdminView();
      showToast("CSV 已整批导入为草稿", "success", 7000);
    } catch (error) {
      if (!state?.context.handleAuthError(error)) showToast(getErrorMessage(error, "CSV 导入失败"), "error");
      setBusy(button, false);
    }
  });
}

function extractAudit(response: { entries?: AuditRecord[]; audit?: AuditRecord[]; items?: AuditRecord[] }): AuditRecord[] {
  return response.entries ?? response.audit ?? response.items ?? [];
}

async function reloadAdminData(context: PageContext, notify = false): Promise<void> {
  const activeState = state;
  if (!activeState || activeState.disposed) return;
  try {
    const [usersResponse, categoryResponse, itemResponse, statsResponse, auditResponse] = await Promise.all([
      api.adminUsers(),
      api.adminCategories(),
      api.adminItems(),
      api.adminStats(),
      api.audit()
    ]);
    if (state !== activeState || activeState.disposed) return;
    activeState.users = usersResponse.users ?? [];
    activeState.categories = categoryResponse.categories ?? [];
    activeState.items = itemResponse.items ?? [];
    activeState.stats = (statsResponse.stats ?? statsResponse) as AdminStats;
    activeState.audit = extractAudit(auditResponse);
    renderAdminView();
    if (notify) showToast("管理数据已刷新", "success");
  } catch (error) {
    if (state !== activeState || activeState.disposed) return;
    if (context.handleAuthError(error)) return;
    context.renderShell(errorMarkup("管理数据读取失败", getErrorMessage(error), "retryAdminButton"), "/admin");
    mustElement<HTMLButtonElement>("#retryAdminButton").addEventListener("click", () => { void reloadAdminData(context); });
  }
}

export async function renderAdmin(context: PageContext): Promise<void> {
  disposeAdmin();
  state = {
    context,
    tab: "overview",
    users: [],
    categories: [],
    items: [],
    stats: {},
    audit: [],
    editingItemId: null,
    contentSearch: "",
    importPreview: null,
    temporaryPassword: null,
    disposed: false
  };
  context.renderShell(`
    <div class="page-title"><div><h1>管理后台</h1><p>正在读取账号、题库和统计数据…</p></div></div>
    <section class="panel"><div class="panel-body"><div class="spinner" aria-hidden="true"></div><p class="muted">正在加载管理数据…</p></div></section>
  `, "/admin");
  await reloadAdminData(context);
}

export function disposeAdmin(): void {
  if (state) state.disposed = true;
  state = null;
}

import "./styles.css";
import { renderAdmin, disposeAdmin } from "./admin";
import { ApiError, api } from "./api";
import { confirmDiscardPendingAttempt, disposePractice, renderPractice } from "./practice";
import type { PageContext, User } from "./types";
import { mustElement, setBusy, shellMarkup, showToast } from "./ui";
import { escapeHtml, getErrorMessage, validatePassword } from "./utils";

const app = mustElement<HTMLElement>("#app");
let currentUser: User | null = null;
let renderSequence = 0;

function disposePage(): void {
  disposePractice();
  disposeAdmin();
}

function normalisePath(pathname: string): "/login" | "/practice" | "/admin" {
  if (pathname === "/login" || pathname === "/practice" || pathname === "/admin") return pathname;
  return currentUser ? "/practice" : "/login";
}

function navigate(path: string, replace = false): void {
  const target = normalisePath(path);
  if (location.pathname === "/practice" && target !== "/practice" && !confirmDiscardPendingAttempt()) return;
  if (replace) history.replaceState({}, "", target);
  else if (location.pathname !== target) history.pushState({}, "", target);
  void renderRoute();
}

function bindRouteLinks(): void {
  document.querySelectorAll<HTMLAnchorElement>("[data-route]").forEach((link) => {
    link.addEventListener("click", (event) => {
      if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      navigate(link.dataset.route ?? link.pathname);
    });
  });
}

function renderShell(content: string, activeRoute: "/practice" | "/admin"): void {
  if (!currentUser) return;
  app.innerHTML = shellMarkup(currentUser, activeRoute, content);
  bindRouteLinks();
  document.querySelector<HTMLButtonElement>("#logoutButton")?.addEventListener("click", (event) => {
    void logout(event.currentTarget as HTMLButtonElement);
  });
}

function onUserChanged(user: User): void {
  currentUser = user;
}

function handleAuthError(error: unknown): boolean {
  if (!(error instanceof ApiError)) return false;
  if (error.status === 401 && error.code !== "CURRENT_PASSWORD_INVALID" && error.code !== "INVALID_CREDENTIALS") {
    void recoverLoginSession();
    return true;
  }
  if (error.status === 403 && error.code === "CSRF_INVALID") {
    void recoverLoginSession();
    return true;
  }
  if (error.status === 403 && error.code === "MUST_CHANGE_PASSWORD" && currentUser) {
    currentUser = { ...currentUser, mustChangePassword: true };
    renderForcedPassword();
    return true;
  }
  return false;
}

async function recoverLoginSession(): Promise<void> {
  const requestedPath = location.pathname;
  currentUser = null;
  disposePage();
  history.replaceState({}, "", "/login");
  app.innerHTML = `
    <main class="screen-center"><section class="loading-card"><div class="spinner" aria-hidden="true"></div><p class="muted">登录已失效，正在重新连接…</p></section></main>
  `;
  try {
    const session = await api.session();
    currentUser = session.user;
    if (currentUser) {
      if (requestedPath === "/login") history.replaceState({}, "", currentUser.role === "admin" ? "/admin" : "/practice");
      await renderRoute();
    } else {
      renderLogin();
    }
  } catch (error) {
    renderBootFailure(error);
  }
}

function pageContext(user: User): PageContext {
  return {
    user,
    renderShell,
    navigate,
    onUserChanged,
    handleAuthError
  };
}

function loginMarkup(): string {
  return `
    <main class="screen-center">
      <section class="auth-card">
        <div class="auth-brand">
          <span class="brand-mark" aria-hidden="true">ET</span>
          <div><h1>英语打字练习</h1><p>登录后开始练习并同步学习记录</p></div>
        </div>
        <form class="form-stack" id="loginForm">
          <label class="field"><span>账号</span><input class="input" name="username" autocomplete="username" autocapitalize="off" required autofocus></label>
          <label class="field"><span>密码</span><input class="input" name="password" type="password" autocomplete="current-password" required></label>
          <div class="message error" id="loginMessage" role="alert" hidden></div>
          <button class="btn primary" type="submit">登录</button>
          <p class="helper">本站不开放自助注册。请向管理员获取账号和一次性临时密码。</p>
        </form>
      </section>
    </main>
    <div class="toast-region" id="toastRegion" role="status" aria-live="polite"></div>
  `;
}

function renderLogin(): void {
  disposePage();
  if (location.pathname !== "/login") history.replaceState({}, "", "/login");
  document.title = "登录 · 英语打字练习";
  app.innerHTML = loginMarkup();
  const form = mustElement<HTMLFormElement>("#loginForm");
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const data = new FormData(form);
    const username = String(data.get("username") ?? "").trim();
    const password = String(data.get("password") ?? "");
    const message = mustElement<HTMLElement>("#loginMessage");
    const submit = mustElement<HTMLButtonElement>('button[type="submit"]', form);
    message.hidden = true;
    setBusy(submit, true, "正在登录…");
    try {
      const response = await api.login(username, password);
      if (!response.user) throw new Error("登录成功但服务器未返回账号信息");
      currentUser = response.user;
      navigate(response.user.role === "admin" ? "/admin" : "/practice", true);
    } catch (error) {
      message.textContent = getErrorMessage(error, "登录失败");
      message.hidden = false;
      setBusy(submit, false);
      mustElement<HTMLInputElement>('[name="password"]', form).select();
    }
  });
}

function forcedPasswordMarkup(user: User): string {
  return `
    <main class="screen-center">
      <section class="forced-password-card">
        <div class="auth-brand">
          <span class="brand-mark" aria-hidden="true">ET</span>
          <div><h1>首次登录，请修改密码</h1><p>你好，${escapeHtml(user.displayName || user.username)}</p></div>
        </div>
        <div class="message warning">临时密码只能用于首次登录。设置新密码后才能进入练习页面。</div>
        <form class="form-stack" id="forcedPasswordForm">
          <label class="field"><span>当前临时密码</span><input class="input" name="currentPassword" type="password" autocomplete="current-password" required autofocus></label>
          <label class="field"><span>新密码（12–128 个字符）</span><input class="input" name="newPassword" type="password" autocomplete="new-password" minlength="12" maxlength="128" required></label>
          <label class="field"><span>确认新密码</span><input class="input" name="confirmPassword" type="password" autocomplete="new-password" minlength="12" maxlength="128" required></label>
          <div class="message error" id="forcedPasswordMessage" role="alert" hidden></div>
          <div class="button-row">
            <button class="btn primary" type="submit">保存新密码</button>
            <button class="btn" id="forcedLogoutButton" type="button">退出登录</button>
          </div>
        </form>
      </section>
    </main>
    <div class="toast-region" id="toastRegion" role="status" aria-live="polite"></div>
  `;
}

function renderForcedPassword(): void {
  disposePage();
  if (!currentUser) {
    renderLogin();
    return;
  }
  document.title = "修改初始密码 · 英语打字练习";
  app.innerHTML = forcedPasswordMarkup(currentUser);
  mustElement<HTMLButtonElement>("#forcedLogoutButton").addEventListener("click", (event) => {
    void logout(event.currentTarget as HTMLButtonElement);
  });
  const form = mustElement<HTMLFormElement>("#forcedPasswordForm");
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const data = new FormData(form);
    const currentPassword = String(data.get("currentPassword") ?? "");
    const newPassword = String(data.get("newPassword") ?? "");
    const confirmation = String(data.get("confirmPassword") ?? "");
    const message = mustElement<HTMLElement>("#forcedPasswordMessage");
    const validation = validatePassword(newPassword);
    if (validation || newPassword !== confirmation) {
      message.textContent = validation ?? "两次输入的新密码不一致";
      message.hidden = false;
      return;
    }
    const submit = mustElement<HTMLButtonElement>('button[type="submit"]', form);
    message.hidden = true;
    setBusy(submit, true, "正在保存…");
    try {
      const response = await api.changePassword(currentPassword, newPassword);
      if (!response.user) throw new Error("服务器未返回账号信息");
      currentUser = response.user;
      showToast("新密码已保存", "success");
      navigate(response.user.role === "admin" ? "/admin" : "/practice", true);
    } catch (error) {
      message.textContent = getErrorMessage(error, "密码修改失败");
      message.hidden = false;
      setBusy(submit, false);
    }
  });
}

async function logout(button: HTMLButtonElement): Promise<void> {
  if (!confirmDiscardPendingAttempt()) {
    setBusy(button, false);
    return;
  }
  setBusy(button, true, "正在退出…");
  try {
    await api.logout();
  } catch (error) {
    if (handleAuthError(error)) return;
    if (!(error instanceof ApiError && error.status === 401)) {
      showToast(getErrorMessage(error, "退出失败，请重试"), "error");
      setBusy(button, false);
      return;
    }
  }
  currentUser = null;
  history.replaceState({}, "", "/login");
  try {
    await api.session();
    renderLogin();
  } catch (error) {
    renderBootFailure(error);
  }
}

async function renderRoute(): Promise<void> {
  const sequence = ++renderSequence;
  if (!currentUser) {
    renderLogin();
    return;
  }
  if (currentUser.mustChangePassword) {
    renderForcedPassword();
    return;
  }

  const route = normalisePath(location.pathname);
  if (location.pathname !== route) history.replaceState({}, "", route);
  if (route === "/login") {
    navigate(currentUser.role === "admin" ? "/admin" : "/practice", true);
    return;
  }
  if (route === "/admin" && currentUser.role !== "admin") {
    navigate("/practice", true);
    return;
  }

  disposePage();
  const context = pageContext(currentUser);
  if (route === "/admin") {
    document.title = "管理后台 · 英语打字练习";
    await renderAdmin(context);
  } else {
    document.title = "练习 · 英语打字练习";
    await renderPractice(context);
  }
  if (sequence !== renderSequence) return;
}

function renderBootFailure(error: unknown): void {
  app.innerHTML = `
    <main class="screen-center">
      <section class="auth-card form-stack">
        <div class="auth-brand"><span class="brand-mark" aria-hidden="true">ET</span><div><h1>无法连接服务器</h1><p>英语打字练习需要联网使用</p></div></div>
        <div class="message error">${escapeHtml(getErrorMessage(error))}</div>
        <button class="btn primary" id="bootRetryButton" type="button">重新连接</button>
      </section>
    </main>
  `;
  mustElement<HTMLButtonElement>("#bootRetryButton").addEventListener("click", () => { void boot(); });
}

async function boot(): Promise<void> {
  app.innerHTML = `
    <main class="screen-center"><section class="loading-card"><div class="spinner" aria-hidden="true"></div><p class="muted">正在连接服务器并检查登录状态…</p></section></main>
  `;
  try {
    const session = await api.session();
    currentUser = session.user;
    await renderRoute();
  } catch (error) {
    renderBootFailure(error);
  }
}

window.addEventListener("popstate", () => {
  if (location.pathname !== "/practice" && !confirmDiscardPendingAttempt()) {
    history.pushState({}, "", "/practice");
    return;
  }
  void renderRoute();
});

if ("serviceWorker" in navigator && window.isSecureContext) {
  window.addEventListener("load", () => {
    void navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch(() => undefined);
  });
}

void boot();

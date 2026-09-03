import type { User } from "./types";
import { escapeHtml } from "./utils";

export type ToastKind = "success" | "error" | "info";

export function shellMarkup(user: User, activeRoute: "/practice" | "/admin", content: string): string {
  const isAdmin = user.role === "admin";
  return `
    <div class="app-shell">
      <header class="app-header">
        <a class="brand-link" href="/practice" data-route="/practice">
          <span class="brand-mark" aria-hidden="true">ET</span>
          <span>英语打字练习</span>
        </a>
        <div class="header-actions">
          <nav class="nav-links" aria-label="主导航">
            <a class="nav-link${activeRoute === "/practice" ? " active" : ""}" href="/practice" data-route="/practice">练习</a>
            ${isAdmin ? `<a class="nav-link${activeRoute === "/admin" ? " active" : ""}" href="/admin" data-route="/admin">管理后台</a>` : ""}
          </nav>
          <div class="user-chip">
            <strong title="${escapeHtml(user.username)}">${escapeHtml(user.displayName || user.username)}</strong>
            <span class="role-pill">${user.role === "admin" ? "管理员" : "学员"}</span>
            <button class="btn ghost small" id="logoutButton" type="button">退出</button>
          </div>
        </div>
      </header>
      ${content}
    </div>
    <div class="toast-region" id="toastRegion" role="status" aria-live="polite"></div>
  `;
}

export function loadingMarkup(message = "正在读取数据…"): string {
  return `
    <div class="screen-center">
      <div class="loading-card">
        <div class="spinner" aria-hidden="true"></div>
        <div class="muted">${escapeHtml(message)}</div>
      </div>
    </div>
  `;
}

export function errorMarkup(title: string, message: string, retryId = "retryButton"): string {
  return `
    <section class="panel">
      <div class="panel-body form-stack">
        <div>
          <h2>${escapeHtml(title)}</h2>
          <p class="muted">${escapeHtml(message)}</p>
        </div>
        <div><button class="btn primary" id="${escapeHtml(retryId)}" type="button">重新加载</button></div>
      </div>
    </section>
  `;
}

export function showToast(message: string, kind: ToastKind = "info", duration = 5000): void {
  const region = document.querySelector<HTMLElement>("#toastRegion");
  if (!region) return;
  const toast = document.createElement("div");
  toast.className = `toast ${kind}`;
  toast.textContent = message;
  region.append(toast);
  window.setTimeout(() => toast.remove(), duration);
}

export function setBusy(button: HTMLButtonElement, busy: boolean, busyLabel = "处理中…"): void {
  if (busy) {
    button.dataset.label = button.textContent ?? "";
    button.textContent = busyLabel;
    button.disabled = true;
  } else {
    button.textContent = button.dataset.label ?? button.textContent;
    button.disabled = false;
    delete button.dataset.label;
  }
}

export function mustElement<T extends Element>(selector: string, root: ParentNode = document): T {
  const element = root.querySelector<T>(selector);
  if (!element) throw new Error(`缺少页面元素：${selector}`);
  return element;
}

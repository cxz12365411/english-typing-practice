import { api } from "./api";
import {
  normalizeEmail,
  retryAfterFromError,
  startVerificationCountdown,
  validateEmail,
  validateVerificationCode
} from "./email";
import type { AuthCapabilities, EmailCodePurpose, SessionResponse } from "./types";
import { mustElement, setBusy } from "./ui";
import { getErrorMessage, validatePassword } from "./utils";

type AuthMode = "email-login" | "register" | "reset-password" | "password-login";

interface LoginCallbacks {
  onAuthenticated: (response: SessionResponse) => void;
}

function setMessage(element: HTMLElement, text: string, kind: "error" | "success" | "info" = "error"): void {
  element.textContent = text;
  element.className = `message compact ${kind}`;
  element.hidden = false;
}

function clearMessage(element: HTMLElement): void {
  element.textContent = "";
  element.hidden = true;
}

function verificationField(prefix: string, label: string): string {
  return `
    <label class="field" for="${prefix}Email"><span>${label}</span></label>
    <div class="verification-row">
      <input class="input" id="${prefix}Email" name="email" type="email" inputmode="email" autocomplete="email" maxlength="254" required>
      <button class="btn" id="${prefix}SendCode" type="button">发送验证码</button>
    </div>
    <input id="${prefix}ChallengeId" name="challengeId" type="hidden">
    <div class="message compact info" id="${prefix}SendStatus" role="status" aria-live="polite" hidden></div>
  `;
}

function passwordLoginForm(): string {
  return `
    <form class="form-stack" id="passwordLoginForm">
      <label class="field"><span>账号</span><input class="input" name="username" autocomplete="username" autocapitalize="off" required></label>
      <label class="field"><span>密码</span><input class="input" name="password" type="password" autocomplete="current-password" required></label>
      <div class="message error" id="passwordLoginMessage" role="alert" hidden></div>
      <button class="btn primary" type="submit">登录</button>
      <p class="helper">管理员和已有账号可继续使用账号密码登录。</p>
    </form>
  `;
}

function enabledAuthMarkup(capabilities: AuthCapabilities): string {
  return `
    <div class="auth-tabs" role="tablist" aria-label="登录方式">
      <button class="auth-tab active" id="email-login-tab" type="button" role="tab" aria-selected="true" aria-controls="email-login-panel" data-auth-mode="email-login">验证码登录</button>
      ${capabilities.selfRegistrationEnabled ? `<button class="auth-tab" id="register-tab" type="button" role="tab" aria-selected="false" aria-controls="register-panel" tabindex="-1" data-auth-mode="register">注册账号</button>` : ""}
      <button class="auth-tab" id="reset-password-tab" type="button" role="tab" aria-selected="false" aria-controls="reset-password-panel" tabindex="-1" data-auth-mode="reset-password">找回密码</button>
      <button class="auth-tab" id="password-login-tab" type="button" role="tab" aria-selected="false" aria-controls="password-login-panel" tabindex="-1" data-auth-mode="password-login">账号密码</button>
    </div>

    <section id="email-login-panel" role="tabpanel" aria-labelledby="email-login-tab" data-auth-panel="email-login">
      <form class="form-stack" id="emailLoginForm">
        ${verificationField("emailLogin", "邮箱")}
        <label class="field"><span>邮箱验证码</span><input class="input code-input" name="code" inputmode="numeric" autocomplete="one-time-code" minlength="6" maxlength="6" pattern="[0-9]{6}" title="请输入 6 位数字验证码" required></label>
        <div class="message error" id="emailLoginMessage" role="alert" hidden></div>
        <button class="btn primary" type="submit">登录</button>
        <p class="helper">验证码只用于本次操作，请勿转发给其他人。已有账号如果尚未绑定邮箱，请先切换到“账号密码”登录，再到“账号安全与邮箱”完成绑定。</p>
      </form>
    </section>

    ${capabilities.selfRegistrationEnabled ? `
      <section id="register-panel" role="tabpanel" aria-labelledby="register-tab" data-auth-panel="register" hidden>
        <form class="form-stack" id="registerForm">
          ${verificationField("register", "邮箱")}
          <label class="field"><span>邮箱验证码</span><input class="input code-input" name="code" inputmode="numeric" autocomplete="one-time-code" minlength="6" maxlength="6" pattern="[0-9]{6}" title="请输入 6 位数字验证码" required></label>
          <label class="field"><span>登录账号</span><input class="input" name="username" autocomplete="username" autocapitalize="off" minlength="3" maxlength="32" pattern="[A-Za-z0-9._-]{3,32}" title="使用 3–32 位英文字母、数字、点、下划线或短横线" required></label>
          <label class="field"><span>显示名称</span><input class="input" name="displayName" autocomplete="name" maxlength="80" required></label>
          <label class="field"><span>密码（12–128 个字符）</span><input class="input" name="password" type="password" autocomplete="new-password" minlength="12" maxlength="128" required></label>
          <label class="field"><span>确认密码</span><input class="input" name="confirmPassword" type="password" autocomplete="new-password" minlength="12" maxlength="128" required></label>
          <div class="message error" id="registerMessage" role="alert" hidden></div>
          <button class="btn primary" type="submit">注册并登录</button>
        </form>
      </section>
    ` : ""}

    <section id="reset-password-panel" role="tabpanel" aria-labelledby="reset-password-tab" data-auth-panel="reset-password" hidden>
      <form class="form-stack" id="resetPasswordForm">
        ${verificationField("resetPassword", "已绑定邮箱")}
        <label class="field"><span>邮箱验证码</span><input class="input code-input" name="code" inputmode="numeric" autocomplete="one-time-code" minlength="6" maxlength="6" pattern="[0-9]{6}" title="请输入 6 位数字验证码" required></label>
        <label class="field"><span>新密码（12–128 个字符）</span><input class="input" name="newPassword" type="password" autocomplete="new-password" minlength="12" maxlength="128" required></label>
        <label class="field"><span>确认新密码</span><input class="input" name="confirmPassword" type="password" autocomplete="new-password" minlength="12" maxlength="128" required></label>
        <div class="message error" id="resetPasswordMessage" role="alert" hidden></div>
        <button class="btn primary" type="submit">验证并修改密码</button>
      </form>
    </section>

    <section id="password-login-panel" role="tabpanel" aria-labelledby="password-login-tab" data-auth-panel="password-login" hidden>
      ${passwordLoginForm()}
    </section>
  `;
}

function loginMarkup(capabilities: AuthCapabilities): string {
  return `
    <main class="screen-center">
      <section class="auth-card${capabilities.emailAuthEnabled ? " email-auth-card" : ""}">
        <div class="auth-brand">
          <span class="brand-mark" aria-hidden="true">ET</span>
          <div><h1>英语打字练习</h1><p>登录后开始练习并同步学习记录</p></div>
        </div>
        ${capabilities.emailAuthEnabled ? enabledAuthMarkup(capabilities) : `
          ${passwordLoginForm()}
          <div class="message info auth-capability-note">邮箱验证码功能正在配置中，当前请使用账号密码登录。</div>
        `}
      </section>
    </main>
    <div class="toast-region" id="toastRegion" role="status" aria-live="polite"></div>
  `;
}

function switchAuthMode(mode: AuthMode): void {
  document.querySelectorAll<HTMLButtonElement>("[data-auth-mode]").forEach((button) => {
    const selected = button.dataset.authMode === mode;
    button.classList.toggle("active", selected);
    button.setAttribute("aria-selected", String(selected));
    button.tabIndex = selected ? 0 : -1;
  });
  document.querySelectorAll<HTMLElement>("[data-auth-panel]").forEach((panel) => {
    panel.hidden = panel.dataset.authPanel !== mode;
  });
  window.requestAnimationFrame(() => {
    document.querySelector<HTMLElement>(`[data-auth-panel="${mode}"] input`)?.focus();
  });
}

function bindTabs(): void {
  const tabs = [...document.querySelectorAll<HTMLButtonElement>("[data-auth-mode]")];
  for (const tab of tabs) {
    tab.addEventListener("click", () => switchAuthMode(tab.dataset.authMode as AuthMode));
    tab.addEventListener("keydown", (event) => {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      event.preventDefault();
      const current = tabs.indexOf(tab);
      const direction = event.key === "ArrowRight" ? 1 : -1;
      const next = tabs[(current + direction + tabs.length) % tabs.length];
      if (next) switchAuthMode(next.dataset.authMode as AuthMode);
    });
  }
}

function bindCodeRequest(prefix: string, purpose: EmailCodePurpose): void {
  const emailInput = mustElement<HTMLInputElement>(`#${prefix}Email`);
  const button = mustElement<HTMLButtonElement>(`#${prefix}SendCode`);
  const status = mustElement<HTMLElement>(`#${prefix}SendStatus`);
  const challengeInput = mustElement<HTMLInputElement>(`#${prefix}ChallengeId`);
  emailInput.addEventListener("input", () => { challengeInput.value = ""; });
  button.addEventListener("click", async () => {
    const email = normalizeEmail(emailInput.value);
    const validation = validateEmail(email);
    if (validation) {
      setMessage(status, validation);
      emailInput.setAttribute("aria-invalid", "true");
      emailInput.focus();
      return;
    }
    emailInput.value = email;
    emailInput.removeAttribute("aria-invalid");
    clearMessage(status);
    setBusy(button, true, "发送中…");
    try {
      const response = await api.requestEmailCode(email, purpose, null);
      challengeInput.value = response.challengeId;
      setBusy(button, false);
      startVerificationCountdown(button, response.retryAfterSeconds);
      setMessage(status, "如果该邮箱符合条件，验证码将发送，请检查收件箱和垃圾邮件。", "success");
    } catch (error) {
      setBusy(button, false);
      const retryAfter = retryAfterFromError(error);
      if (retryAfter !== null) startVerificationCountdown(button, retryAfter);
      setMessage(status, getErrorMessage(error, "验证码发送失败"));
    }
  });
}

function requireChallengeId(form: HTMLFormElement, message: HTMLElement): string | null {
  const challengeId = String(new FormData(form).get("challengeId") ?? "");
  if (/^[0-9a-f-]{36}$/i.test(challengeId)) return challengeId;
  setMessage(message, "请先获取新的邮箱验证码");
  return null;
}

function requireValidEmail(form: HTMLFormElement, message: HTMLElement): string | null {
  const emailInput = mustElement<HTMLInputElement>('[name="email"]', form);
  const email = normalizeEmail(emailInput.value);
  const validation = validateEmail(email);
  if (!validation) {
    emailInput.value = email;
    emailInput.removeAttribute("aria-invalid");
    return email;
  }
  emailInput.setAttribute("aria-invalid", "true");
  setMessage(message, validation);
  emailInput.focus();
  return null;
}

function requireValidCode(form: HTMLFormElement, message: HTMLElement): string | null {
  const codeInput = mustElement<HTMLInputElement>('[name="code"]', form);
  const code = codeInput.value.trim();
  const validation = validateVerificationCode(code);
  if (!validation) {
    codeInput.removeAttribute("aria-invalid");
    return code;
  }
  codeInput.setAttribute("aria-invalid", "true");
  setMessage(message, validation);
  codeInput.focus();
  return null;
}

function bindPasswordLogin(callbacks: LoginCallbacks): void {
  const form = mustElement<HTMLFormElement>("#passwordLoginForm");
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const data = new FormData(form);
    const message = mustElement<HTMLElement>("#passwordLoginMessage");
    const submit = mustElement<HTMLButtonElement>('button[type="submit"]', form);
    clearMessage(message);
    setBusy(submit, true, "正在登录…");
    try {
      const response = await api.login(String(data.get("username") ?? "").trim(), String(data.get("password") ?? ""));
      if (!response.user) throw new Error("登录成功但服务器未返回账号信息");
      callbacks.onAuthenticated(response);
    } catch (error) {
      setMessage(message, getErrorMessage(error, "登录失败"));
      setBusy(submit, false);
      mustElement<HTMLInputElement>('[name="password"]', form).select();
    }
  });
}

function bindEmailLogin(callbacks: LoginCallbacks): void {
  bindCodeRequest("emailLogin", "login");
  const form = mustElement<HTMLFormElement>("#emailLoginForm");
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const message = mustElement<HTMLElement>("#emailLoginMessage");
    const email = requireValidEmail(form, message);
    if (!email) return;
    const code = requireValidCode(form, message);
    if (!code) return;
    const challengeId = requireChallengeId(form, message);
    if (!challengeId) return;
    const submit = mustElement<HTMLButtonElement>('button[type="submit"]', form);
    clearMessage(message);
    setBusy(submit, true, "正在登录…");
    try {
      const response = await api.loginWithEmail(email, challengeId, code);
      if (!response.user) throw new Error("登录成功但服务器未返回账号信息");
      callbacks.onAuthenticated(response);
    } catch (error) {
      setMessage(message, getErrorMessage(error, "登录失败"));
      setBusy(submit, false);
      mustElement<HTMLInputElement>('[name="code"]', form).select();
    }
  });
}

function bindRegistration(callbacks: LoginCallbacks): void {
  const form = document.querySelector<HTMLFormElement>("#registerForm");
  if (!form) return;
  bindCodeRequest("register", "register");
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const message = mustElement<HTMLElement>("#registerMessage");
    const email = requireValidEmail(form, message);
    if (!email) return;
    const code = requireValidCode(form, message);
    if (!code) return;
    const challengeId = requireChallengeId(form, message);
    if (!challengeId) return;
    const data = new FormData(form);
    const password = String(data.get("password") ?? "");
    const confirmation = String(data.get("confirmPassword") ?? "");
    const validation = validatePassword(password);
    if (validation || password !== confirmation) {
      setMessage(message, validation ?? "两次输入的密码不一致");
      return;
    }
    const submit = mustElement<HTMLButtonElement>('button[type="submit"]', form);
    clearMessage(message);
    setBusy(submit, true, "正在注册…");
    try {
      const response = await api.registerWithEmail({
        email,
        challengeId,
        code,
        username: String(data.get("username") ?? "").trim().toLocaleLowerCase("en-US"),
        displayName: String(data.get("displayName") ?? "").trim(),
        password
      });
      if (!response.user) throw new Error("注册成功但服务器未返回账号信息");
      callbacks.onAuthenticated(response);
    } catch (error) {
      setMessage(message, getErrorMessage(error, "注册失败"));
      setBusy(submit, false);
    }
  });
}

function bindPasswordReset(callbacks: LoginCallbacks): void {
  bindCodeRequest("resetPassword", "reset_password");
  const form = mustElement<HTMLFormElement>("#resetPasswordForm");
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const message = mustElement<HTMLElement>("#resetPasswordMessage");
    const email = requireValidEmail(form, message);
    if (!email) return;
    const code = requireValidCode(form, message);
    if (!code) return;
    const challengeId = requireChallengeId(form, message);
    if (!challengeId) return;
    const data = new FormData(form);
    const newPassword = String(data.get("newPassword") ?? "");
    const confirmation = String(data.get("confirmPassword") ?? "");
    const validation = validatePassword(newPassword);
    if (validation || newPassword !== confirmation) {
      setMessage(message, validation ?? "两次输入的新密码不一致");
      return;
    }
    const submit = mustElement<HTMLButtonElement>('button[type="submit"]', form);
    clearMessage(message);
    setBusy(submit, true, "正在修改…");
    try {
      const response = await api.resetPasswordWithEmail(
        email,
        challengeId,
        code,
        newPassword
      );
      if (!response.user) throw new Error("密码已修改，但服务器未返回账号信息");
      callbacks.onAuthenticated(response);
    } catch (error) {
      setMessage(message, getErrorMessage(error, "密码修改失败"));
      setBusy(submit, false);
    }
  });
}

export function renderLoginScreen(
  app: HTMLElement,
  capabilities: AuthCapabilities,
  callbacks: LoginCallbacks
): void {
  app.innerHTML = loginMarkup(capabilities);
  bindPasswordLogin(callbacks);
  if (!capabilities.emailAuthEnabled) {
    mustElement<HTMLInputElement>('[name="username"]', mustElement("#passwordLoginForm")).focus();
    return;
  }
  bindTabs();
  bindEmailLogin(callbacks);
  bindRegistration(callbacks);
  bindPasswordReset(callbacks);
  switchAuthMode(capabilities.selfRegistrationEnabled ? "email-login" : "password-login");
}

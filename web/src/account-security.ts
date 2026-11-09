import { api } from "./api";
import { clearVerificationCountdowns, normalizeEmail, retryAfterFromError, startVerificationCountdown, validateEmail, validateVerificationCode } from "./email";
import type { EmailCodePurpose, PageContext, User } from "./types";
import { mustElement, setBusy, showToast } from "./ui";
import { escapeHtml, getErrorMessage, validatePassword } from "./utils";
function currentPasswordFormMarkup(): string {
  return `
    <section class="account-security-card">
      <h3>使用当前密码修改</h3>
      <p class="muted">管理员或暂未绑定邮箱的账号仍可使用此方式。</p>
      <form class="form-stack" id="changePasswordForm">
        <label class="field"><span>当前密码</span><input class="input" name="currentPassword" type="password" autocomplete="current-password" required></label>
        <label class="field"><span>新密码（12–128 个字符）</span><input class="input" name="newPassword" type="password" autocomplete="new-password" minlength="12" maxlength="128" required></label>
        <label class="field"><span>确认新密码</span><input class="input" name="confirmPassword" type="password" autocomplete="new-password" minlength="12" maxlength="128" required></label>
        <div class="message error" id="passwordMessage" role="alert" hidden></div>
        <div><button class="btn" type="submit">修改密码</button></div>
      </form>
    </section>
  `;
}

export function accountMarkup(user: User, emailAuthEnabled: boolean): string {
  const email = user.email?.trim() ?? "";
  const emailSection = !emailAuthEnabled ? `
    <section class="account-security-card account-security-primary">
      <h3>邮箱验证码</h3>
      <div class="message info">邮箱验证码功能正在配置中，启用后可在这里绑定邮箱并用验证码修改密码。</div>
    </section>
  ` : email ? `
    <section class="account-security-card account-security-primary">
      <h3>邮箱验证码修改密码</h3>
      <p class="account-email"><span>已绑定邮箱</span><strong>${escapeHtml(email)}</strong><span class="status-pill active">已验证</span></p>
      <p class="muted">验证码将发送到上面的邮箱。修改成功后，其他设备上的登录会话将失效。</p>
      <form class="form-stack" id="emailPasswordForm">
        <input name="challengeId" type="hidden">
        <div>
          <button class="btn" id="accountPasswordSendCode" type="button">发送验证码</button>
          <div class="message compact info account-code-status" id="accountPasswordSendStatus" role="status" aria-live="polite" hidden></div>
        </div>
        <label class="field"><span>邮箱验证码</span><input class="input code-input" name="code" inputmode="numeric" autocomplete="one-time-code" minlength="6" maxlength="6" pattern="[0-9]{6}" title="请输入 6 位数字验证码" required></label>
        <label class="field"><span>新密码（12–128 个字符）</span><input class="input" name="newPassword" type="password" autocomplete="new-password" minlength="12" maxlength="128" required></label>
        <label class="field"><span>确认新密码</span><input class="input" name="confirmPassword" type="password" autocomplete="new-password" minlength="12" maxlength="128" required></label>
        <div class="message error" id="emailPasswordMessage" role="alert" hidden></div>
        <div><button class="btn primary" type="submit">验证并修改密码</button></div>
      </form>
      <p class="helper">为保护账号，当前不支持自行更换已绑定邮箱；如需更换请联系管理员。</p>
    </section>
  ` : `
    <section class="account-security-card account-security-primary">
      <h3>绑定登录邮箱</h3>
      <p class="muted">绑定并验证后，可以用邮箱验证码登录和找回密码。一个邮箱只能绑定一个账号。</p>
      <form class="form-stack" id="bindEmailForm">
        <input name="challengeId" type="hidden">
        <label class="field" for="bindEmailInput"><span>邮箱</span></label>
        <div class="verification-row">
          <input class="input" id="bindEmailInput" name="email" type="email" inputmode="email" autocomplete="email" maxlength="254" required>
          <button class="btn" id="bindEmailSendCode" type="button">发送验证码</button>
        </div>
        <div class="message compact info" id="bindEmailSendStatus" role="status" aria-live="polite" hidden></div>
        <label class="field"><span>邮箱验证码</span><input class="input code-input" name="code" inputmode="numeric" autocomplete="one-time-code" minlength="6" maxlength="6" pattern="[0-9]{6}" title="请输入 6 位数字验证码" required></label>
        <label class="field"><span>当前账号密码</span><input class="input" name="currentPassword" type="password" autocomplete="current-password" required><span class="helper">为防止登录会话被盗用，首次绑定邮箱需要再次验证当前密码。</span></label>
        <div class="message error" id="bindEmailMessage" role="alert" hidden></div>
        <div><button class="btn primary" type="submit">确认绑定</button></div>
      </form>
    </section>
  `;

  return `
    <details class="panel account-panel">
      <summary>账号安全与邮箱</summary>
      <div class="panel-body account-security-grid">
        <section class="account-security-card"><h3>显示名称</h3><form id="profileForm" class="form-stack"><label class="field"><span>昵称</span><input class="input" name="displayName" value="${escapeHtml(user.displayName)}" maxlength="80" required></label><p class="helper">登录账号：${escapeHtml(user.username)}</p><div id="profileMessage" class="message" role="status" hidden></div><div><button class="btn" type="submit">保存昵称</button></div></form></section>
        ${emailSection}
        ${currentPasswordFormMarkup()}
      </div>
    </details>
  `;
}

export function bindAccountSecurity(context: PageContext): { destroy(): void } {
  let state: { context: PageContext } | null = { context };
  const isActive = (candidate: { context: PageContext }) => state === candidate;
function setAccountMessage(element: HTMLElement, text: string, kind: "error" | "success" | "info" = "error"): void {
  element.textContent = text;
  element.className = `message compact ${kind}`;
  element.hidden = false;
}

function clearAccountMessage(element: HTMLElement): void {
  element.textContent = "";
  element.hidden = true;
}

async function sendAccountCode(
  button: HTMLButtonElement,
  status: HTMLElement,
  email: string,
  purpose: EmailCodePurpose
): Promise<string | null> {
  const activeState = state;
  const expectedUserId = activeState?.context.user.id;
  if (!activeState || !expectedUserId || button.disabled) return null;
  clearAccountMessage(status);
  setBusy(button, true, "发送中…");
  try {
    const response = await api.requestEmailCode(email, purpose, expectedUserId);
    if (!isActive(activeState) || !button.isConnected) return null;
    setBusy(button, false);
    startVerificationCountdown(button, response.retryAfterSeconds);
    setAccountMessage(status, "如果该邮箱符合条件，验证码将发送，请检查收件箱和垃圾邮件。", "success");
    return response.challengeId;
  } catch (error) {
    if (!isActive(activeState) || !button.isConnected) return null;
    setBusy(button, false);
    if (state?.context.handleAuthError(error)) return null;
    const retryAfter = retryAfterFromError(error);
    if (retryAfter !== null) startVerificationCountdown(button, retryAfter);
    setAccountMessage(status, getErrorMessage(error, "验证码发送失败"));
    return null;
  }
}

function bindEmailAccountForms(): void {
  if (!state?.context.capabilities.emailAuthEnabled) return;
  const boundEmail = state.context.user.email?.trim() ?? "";
  if (boundEmail) {
    const form = mustElement<HTMLFormElement>("#emailPasswordForm");
    const sendButton = mustElement<HTMLButtonElement>("#accountPasswordSendCode");
    const sendStatus = mustElement<HTMLElement>("#accountPasswordSendStatus");
    sendButton.addEventListener("click", () => {
      if (sendButton.disabled) return;
      mustElement<HTMLInputElement>('[name="challengeId"]', form).value = "";
      void sendAccountCode(sendButton, sendStatus, boundEmail, "reset_password").then((challengeId) => {
        if (!form.isConnected) return;
        mustElement<HTMLInputElement>('[name="challengeId"]', form).value = challengeId ?? "";
      });
    });
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      if (!state) return;
      const activeState = state;
      const data = new FormData(form);
      const challengeId = String(data.get("challengeId") ?? "");
      const code = String(data.get("code") ?? "").trim();
      const newPassword = String(data.get("newPassword") ?? "");
      const confirmation = String(data.get("confirmPassword") ?? "");
      const message = mustElement<HTMLElement>("#emailPasswordMessage");
      const codeValidation = validateVerificationCode(code);
      if (codeValidation) {
        setAccountMessage(message, codeValidation);
        mustElement<HTMLInputElement>('[name="code"]', form).focus();
        return;
      }
      if (!challengeId) {
        setAccountMessage(message, "请先获取新的邮箱验证码");
        return;
      }
      const validation = validatePassword(newPassword);
      if (validation || newPassword !== confirmation) {
        setAccountMessage(message, validation ?? "两次输入的新密码不一致");
        return;
      }
      const submit = mustElement<HTMLButtonElement>('button[type="submit"]', form);
      if (submit.disabled) return;
      clearAccountMessage(message);
      setBusy(submit, true, "正在修改…");
      try {
        const response = await api.resetPasswordWithEmail(
          boundEmail,
          challengeId,
          code,
          newPassword
        );
        if (!isActive(activeState) || !form.isConnected) return;
        if (!response.user) throw new Error("服务器未返回账号信息");
        state.context.user = response.user;
        state.context.onUserChanged(response.user);
        form.reset();
        setAccountMessage(message, "密码已修改，其他登录会话已撤销。", "success");
      } catch (error) {
        if (!isActive(activeState) || !form.isConnected) return;
        if (!state?.context.handleAuthError(error)) {
          setAccountMessage(message, getErrorMessage(error, "密码修改失败"));
        }
      } finally {
        setBusy(submit, false);
      }
    });
    return;
  }

  const form = mustElement<HTMLFormElement>("#bindEmailForm");
  const emailInput = mustElement<HTMLInputElement>("#bindEmailInput");
  const sendButton = mustElement<HTMLButtonElement>("#bindEmailSendCode");
  const sendStatus = mustElement<HTMLElement>("#bindEmailSendStatus");
  const challengeInput = mustElement<HTMLInputElement>('[name="challengeId"]', form);
  let emailVersion = 0;
  emailInput.addEventListener("input", () => {
    emailVersion += 1;
    challengeInput.value = "";
    clearAccountMessage(sendStatus);
  });
  sendButton.addEventListener("click", () => {
    if (sendButton.disabled) return;
    const email = normalizeEmail(emailInput.value);
    const validation = validateEmail(email);
    if (validation) {
      emailInput.setAttribute("aria-invalid", "true");
      setAccountMessage(sendStatus, validation);
      emailInput.focus();
      return;
    }
    emailInput.value = email;
    emailInput.removeAttribute("aria-invalid");
    const requestedVersion = emailVersion;
    challengeInput.value = "";
    void sendAccountCode(sendButton, sendStatus, email, "bind_email").then((challengeId) => {
      if (!form.isConnected) return;
      if (requestedVersion !== emailVersion) {
        clearAccountMessage(sendStatus);
        return;
      }
      challengeInput.value = challengeId ?? "";
    });
  });
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!state) return;
    const activeState = state;
    const email = normalizeEmail(emailInput.value);
    const message = mustElement<HTMLElement>("#bindEmailMessage");
    const validation = validateEmail(email);
    if (validation) {
      emailInput.setAttribute("aria-invalid", "true");
      setAccountMessage(message, validation);
      emailInput.focus();
      return;
    }
    emailInput.value = email;
    emailInput.removeAttribute("aria-invalid");
    const data = new FormData(form);
    const challengeId = String(data.get("challengeId") ?? "");
    const code = String(data.get("code") ?? "").trim();
    const currentPassword = String(data.get("currentPassword") ?? "");
    const codeValidation = validateVerificationCode(code);
    if (codeValidation) {
      setAccountMessage(message, codeValidation);
      mustElement<HTMLInputElement>('[name="code"]', form).focus();
      return;
    }
    if (!challengeId) {
      setAccountMessage(message, "请先获取新的邮箱验证码");
      return;
    }
    const submit = mustElement<HTMLButtonElement>('button[type="submit"]', form);
    if (submit.disabled) return;
    clearAccountMessage(message);
    setBusy(submit, true, "正在绑定…");
    try {
      const response = await api.bindEmail(email, challengeId, code, currentPassword);
      if (!isActive(activeState) || !form.isConnected) return;
      if (!response.user) throw new Error("服务器未返回账号信息");
      state.context.user = response.user;
      state.context.onUserChanged(response.user);
      clearVerificationCountdowns();
      const panel = mustElement<HTMLDetailsElement>(".account-panel");
      const wasOpen = panel.open;
      panel.outerHTML = accountMarkup(response.user, state.context.capabilities.emailAuthEnabled);
      mustElement<HTMLDetailsElement>(".account-panel").open = wasOpen;
      bindEmailAccountForms();
      bindPasswordForm();
      bindProfileForm();
      showToast("邮箱已绑定，现在可以使用邮箱验证码登录和修改密码。", "success");
    } catch (error) {
      if (!isActive(activeState) || !form.isConnected) return;
      if (!state?.context.handleAuthError(error)) {
        setAccountMessage(message, getErrorMessage(error, "邮箱绑定失败"));
      }
      setBusy(submit, false);
    }
  });
}

function bindPasswordForm(): void {
  const form = mustElement<HTMLFormElement>("#changePasswordForm");
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!state) return;
    const activeState = state;
    const data = new FormData(form);
    const currentPassword = String(data.get("currentPassword") ?? "");
    const newPassword = String(data.get("newPassword") ?? "");
    const confirmPassword = String(data.get("confirmPassword") ?? "");
    const message = mustElement<HTMLElement>("#passwordMessage");
    const validation = validatePassword(newPassword);
    if (validation || newPassword !== confirmPassword) {
      message.textContent = validation ?? "两次输入的新密码不一致";
      message.hidden = false;
      return;
    }
    const submit = mustElement<HTMLButtonElement>('button[type="submit"]', form);
    if (submit.disabled) return;
    setBusy(submit, true, "正在修改…");
    message.hidden = true;
    try {
      const response = await api.changePassword(currentPassword, newPassword);
      if (!isActive(activeState) || !form.isConnected) return;
      if (!response.user) throw new Error("服务器未返回账号信息");
      state.context.user = response.user;
      state.context.onUserChanged(response.user);
      form.reset();
      showToast("密码已修改，其他登录会话已撤销", "success");
    } catch (error) {
      if (!isActive(activeState) || !form.isConnected) return;
      if (!state?.context.handleAuthError(error)) {
        message.textContent = getErrorMessage(error, "密码修改失败");
        message.hidden = false;
      }
    } finally {
      setBusy(submit, false);
    }
  });
}


  function bindProfileForm(): void {
    const form = mustElement<HTMLFormElement>("#profileForm");
    form.addEventListener("submit", async event => {
      event.preventDefault();
      if (!state) return;
      const activeState = state;
      const button = mustElement<HTMLButtonElement>('button[type="submit"]', form);
      if (button.disabled) return;
      const name = String(new FormData(form).get("displayName") ?? "").trim();
      const message = mustElement<HTMLElement>("#profileMessage");
      if (!name) { setAccountMessage(message, "请输入昵称"); return; }
      setBusy(button, true);
      try {
        const response = await api.updateProfile(name);
        if (!isActive(activeState) || !form.isConnected) return;
        state.context.user = response.user;
        state.context.onUserChanged(response.user);
        setAccountMessage(message, "昵称已保存", "success");
      } catch(error) { if (isActive(activeState) && !context.handleAuthError(error)) setAccountMessage(message, getErrorMessage(error)); }
      finally { if (form.isConnected) setBusy(button, false); }
    });
  }
  bindEmailAccountForms();
  bindPasswordForm();
  bindProfileForm();
  return { destroy() { state = null; clearVerificationCountdowns(); } };
}

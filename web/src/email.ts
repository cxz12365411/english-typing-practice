import { ApiError } from "./api";

const DEFAULT_COOLDOWN_SECONDS = 60;
const MAX_COOLDOWN_SECONDS = 15 * 60;

interface ActiveCountdown {
  button: HTMLButtonElement;
  originalLabel: string;
  timer: number;
}

const activeCountdowns = new Set<ActiveCountdown>();

export function normalizeEmail(value: string): string {
  return value.normalize("NFKC").trim().toLocaleLowerCase("en-US");
}

export function validateEmail(value: string): string | null {
  const email = normalizeEmail(value);
  if (!email) return "请输入邮箱地址";
  if (email.length > 254) return "邮箱地址不能超过 254 个字符";
  const parts = email.split("@");
  if (parts.length !== 2) return "请输入有效的邮箱地址";
  const [local, domain] = parts as [string, string];
  if (
    local.length < 1 ||
    local.length > 64 ||
    local.startsWith(".") ||
    local.endsWith(".") ||
    local.includes("..") ||
    !/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+$/i.test(local)
  ) return "请输入有效的邮箱地址";
  const labels = domain.split(".");
  if (
    domain.length > 253 ||
    labels.length < 2 ||
    labels.some((label) => label.length < 1 || label.length > 63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(label))
  ) return "请输入有效的邮箱地址";
  return null;
}

export function validateVerificationCode(value: string): string | null {
  return /^\d{6}$/.test(value.trim()) ? null : "请输入 6 位数字验证码";
}

export function normalizeRetryAfterSeconds(value: unknown, fallback = DEFAULT_COOLDOWN_SECONDS): number {
  const seconds = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) return fallback;
  return Math.min(MAX_COOLDOWN_SECONDS, Math.max(1, Math.ceil(seconds)));
}

export function retryAfterFromError(error: unknown): number | null {
  if (!(error instanceof ApiError) || !error.details || typeof error.details !== "object") return null;
  const details = error.details as { retryAfterSeconds?: unknown };
  return details.retryAfterSeconds === undefined ? null : normalizeRetryAfterSeconds(details.retryAfterSeconds);
}

function stopCountdown(countdown: ActiveCountdown, restore = true): void {
  window.clearInterval(countdown.timer);
  activeCountdowns.delete(countdown);
  if (!restore || !countdown.button.isConnected) return;
  countdown.button.textContent = countdown.originalLabel;
  countdown.button.disabled = false;
  delete countdown.button.dataset.cooldown;
}

export function startVerificationCountdown(button: HTMLButtonElement, seconds: unknown): void {
  for (const countdown of activeCountdowns) {
    if (countdown.button === button) stopCountdown(countdown, false);
  }

  const originalLabel = button.dataset.defaultLabel ?? button.textContent?.trim() ?? "发送验证码";
  button.dataset.defaultLabel = originalLabel;
  const endsAt = Date.now() + normalizeRetryAfterSeconds(seconds) * 1000;
  const countdown: ActiveCountdown = { button, originalLabel, timer: 0 };

  const update = (): void => {
    const remaining = Math.max(0, Math.ceil((endsAt - Date.now()) / 1000));
    if (remaining <= 0) {
      stopCountdown(countdown);
      return;
    }
    button.disabled = true;
    button.dataset.cooldown = "true";
    button.textContent = `${remaining} 秒后重发`;
  };

  update();
  countdown.timer = window.setInterval(update, 250);
  activeCountdowns.add(countdown);
}

export function clearVerificationCountdowns(): void {
  for (const countdown of [...activeCountdowns]) stopCountdown(countdown, false);
}

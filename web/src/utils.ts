import type { ContentItem, OrderMode } from "./types";

export function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

export function normalizeAnswer(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .trim()
    .replace(/\s+/g, " ")
    .toLocaleLowerCase("en-US");
}

export function shuffle<T>(items: readonly T[], random: () => number = Math.random): T[] {
  const copy = [...items];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const other = Math.floor(random() * (index + 1));
    const temporary = copy[index];
    copy[index] = copy[other] as T;
    copy[other] = temporary as T;
  }
  return copy;
}

export function buildPracticePool(
  items: readonly ContentItem[],
  categoryId: string,
  mode: OrderMode,
  mistakeItemIds: ReadonlySet<string>,
  random: () => number = Math.random
): ContentItem[] {
  const categoryItems = categoryId === "all"
    ? [...items]
    : items.filter((item) => item.categoryId === categoryId);
  const filtered = mode === "mistakes"
    ? categoryItems.filter((item) => mistakeItemIds.has(item.id))
    : categoryItems;
  return mode === "shuffle" ? shuffle(filtered, random) : filtered;
}

export function parseLegacyMistakes(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return [...new Set(parsed.filter((entry): entry is string => typeof entry === "string")
      .map((entry) => entry.trim())
      .filter(Boolean))];
  } catch {
    return [];
  }
}

export function validatePassword(password: string): string | null {
  if (password.length < 12) return "新密码至少需要 12 个字符";
  if (password.length > 128) return "新密码不能超过 128 个字符";
  return null;
}

export function formatDate(value?: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(date);
}

export function getErrorMessage(error: unknown, fallback = "操作失败，请稍后重试"): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

export function newId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export function numberValue(value: FormDataEntryValue | null, fallback = 0): number {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

export function shouldRefreshContentForAttemptError(code: string): boolean {
  return code === "CONTENT_CHANGED" || code === "CONTENT_UNAVAILABLE";
}

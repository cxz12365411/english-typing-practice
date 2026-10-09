/** Keep only supported same-origin routes and the practice batch parameter. */
export function normaliseAppRoute(input: string, origin: string, fallback: "/login" | "/practice"): string {
  let url: URL;
  try { url = new URL(input, origin); } catch { return fallback; }
  if (url.origin !== origin || !["/login", "/admin", "/practice"].includes(url.pathname)) return fallback;
  if (url.pathname !== "/practice" || !url.searchParams.has("batch")) return url.pathname;
  const values = url.searchParams.getAll("batch");
  // Preserve invalid batch requests as an explicit error, never silently open the whole bank.
  const value = values.length === 1 ? values[0]! : "";
  return `/practice?batch=${encodeURIComponent(value)}`;
}

export function practiceBatchId(search: string): string | undefined {
  const params = new URLSearchParams(search);
  if (!params.has("batch")) return undefined;
  const values = params.getAll("batch");
  if (values.length !== 1 || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/.test(values[0] ?? "")) {
    throw new Error("本次文件练习链接无效，请从批量导入结果重新进入。");
  }
  return values[0];
}

import type {
  AdminCategoryListResponse,
  AdminItemListResponse,
  AdminStatsResponse,
  AdminUserListResponse,
  AdminUserMutationResponse,
  AttemptResponse,
  AuditResponse,
  ContentCategory,
  ContentItem,
  ContentResponse,
  ImportMistakesResponse,
  ImportPreviewResponse,
  MistakesResponse,
  OrderMode,
  PracticeSession,
  Role,
  SessionResponse,
  User
} from "./types";

interface ApiErrorPayload {
  error?: {
    code?: string;
    message?: string;
    details?: unknown;
  };
}

const FRIENDLY_ERRORS: Record<string, string> = {
  INVALID_CREDENTIALS: "账号或密码错误",
  LOGIN_RATE_LIMITED: "登录尝试次数过多，请稍后再试",
  CURRENT_PASSWORD_INVALID: "当前密码不正确",
  INVALID_PASSWORD: "密码必须为 12–128 个字符",
  PASSWORD_UNCHANGED: "新密码不能与当前密码相同",
  AUTH_REQUIRED: "登录已失效，请重新登录",
  SESSION_EXPIRED: "登录已过期，请重新登录",
  MUST_CHANGE_PASSWORD: "请先修改初始密码",
  FORBIDDEN: "当前账号没有执行此操作的权限",
  LAST_ADMIN: "不能停用或降级最后一个有效管理员",
  USERNAME_EXISTS: "该登录账号已存在",
  CATEGORY_SLUG_EXISTS: "该分类标识已存在",
  CATEGORY_NOT_EMPTY: "包含题目的分类不能更改类型",
  CATEGORY_NOT_PUBLISHED: "请先发布题目所属分类",
  ITEM_KEY_EXISTS: "该题目唯一键已存在",
  IMPORT_HAS_ERRORS: "CSV 仍有错误，不能提交导入",
  IMPORT_ALREADY_COMMITTED: "这份 CSV 预览已经提交",
  IMPORT_EXPIRED: "CSV 预览已过期，请重新校验",
  NETWORK_ERROR: "无法连接服务器，请检查网络后重试"
};

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

type RequestOptions = {
  method?: "GET" | "POST" | "PATCH" | "DELETE";
  body?: unknown;
};

class ApiClient {
  private csrfToken = "";

  setCsrfToken(token: string): void {
    this.csrfToken = token;
  }

  async request<T>(path: string, options: RequestOptions = {}): Promise<T> {
    const method = options.method ?? "GET";
    const headers = new Headers({ Accept: "application/json" });
    if (options.body !== undefined) headers.set("Content-Type", "application/json");
    if (method !== "GET" && this.csrfToken) headers.set("X-CSRF-Token", this.csrfToken);

    let response: Response;
    try {
      response = await fetch(path, {
        method,
        headers,
        credentials: "include",
        cache: "no-store",
        body: options.body === undefined ? undefined : JSON.stringify(options.body)
      });
    } catch {
      throw new ApiError(0, "NETWORK_ERROR", "无法连接服务器，请检查网络后重试");
    }

    if (response.status === 204) return undefined as T;
    const payload = await response.json().catch(() => ({})) as ApiErrorPayload & T;
    if (!response.ok) {
      const code = payload.error?.code ?? "REQUEST_FAILED";
      throw new ApiError(
        response.status,
        code,
        FRIENDLY_ERRORS[code] ?? payload.error?.message ?? `请求失败（${response.status}）`,
        payload.error?.details
      );
    }
    return payload as T;
  }

  async session(): Promise<SessionResponse> {
    const response = await this.request<SessionResponse>("/api/auth/session");
    this.setCsrfToken(response.csrfToken);
    return response;
  }

  async login(username: string, password: string): Promise<SessionResponse> {
    const response = await this.request<SessionResponse>("/api/auth/login", {
      method: "POST",
      body: { username, password }
    });
    this.setCsrfToken(response.csrfToken);
    return response;
  }

  logout(): Promise<void> {
    return this.request<void>("/api/auth/logout", { method: "POST" });
  }

  async changePassword(currentPassword: string, newPassword: string): Promise<SessionResponse> {
    const response = await this.request<SessionResponse>("/api/auth/change-password", {
      method: "POST",
      body: { currentPassword, newPassword }
    });
    this.setCsrfToken(response.csrfToken);
    return response;
  }

  content(): Promise<ContentResponse> {
    return this.request<ContentResponse>("/api/content");
  }

  createPracticeSession(categoryId: string, mode: OrderMode): Promise<{ session: PracticeSession }> {
    const apiMode = mode === "order" ? "sequential" : mode === "shuffle" ? "random" : "mistakes";
    return this.request<{ session: PracticeSession }>("/api/practice/sessions", {
      method: "POST",
      body: { categoryId: categoryId === "all" ? undefined : categoryId, mode: apiMode }
    });
  }

  attempt(sessionId: string, body: {
    clientAttemptId: string;
    itemId: string;
    itemRevision: number;
    answer: string;
    durationMs: number;
    occurredAt: string;
  }): Promise<AttemptResponse> {
    return this.request<AttemptResponse>(`/api/practice/sessions/${encodeURIComponent(sessionId)}/attempts`, {
      method: "POST",
      body
    });
  }

  finishPracticeSession(sessionId: string, durationMs: number): Promise<unknown> {
    return this.request(`/api/practice/sessions/${encodeURIComponent(sessionId)}/finish`, {
      method: "POST",
      body: { durationMs }
    });
  }

  summary(): Promise<Record<string, unknown>> {
    return this.request("/api/me/summary");
  }

  mistakes(): Promise<MistakesResponse> {
    return this.request("/api/me/mistakes");
  }

  importMistakes(keys: string[]): Promise<ImportMistakesResponse> {
    return this.request("/api/me/mistakes/import", { method: "POST", body: { answers: keys } });
  }

  adminUsers(): Promise<AdminUserListResponse> {
    return this.request("/api/admin/users");
  }

  createUser(input: { username: string; displayName: string; role: Role }): Promise<AdminUserMutationResponse> {
    return this.request("/api/admin/users", { method: "POST", body: input });
  }

  updateUser(id: string, input: Partial<Pick<User, "displayName" | "role">> & { active?: boolean }): Promise<AdminUserMutationResponse> {
    return this.request(`/api/admin/users/${encodeURIComponent(id)}`, { method: "PATCH", body: input });
  }

  resetPassword(id: string): Promise<AdminUserMutationResponse> {
    return this.request(`/api/admin/users/${encodeURIComponent(id)}/reset-password`, { method: "POST", body: {} });
  }

  revokeSessions(id: string): Promise<void> {
    return this.request(`/api/admin/users/${encodeURIComponent(id)}/revoke-sessions`, { method: "POST", body: {} });
  }

  adminStats(): Promise<AdminStatsResponse> {
    return this.request("/api/admin/stats");
  }

  adminCategories(): Promise<AdminCategoryListResponse> {
    return this.request("/api/admin/categories");
  }

  createCategory(input: { slug: string; name: string; kind: ContentCategory["kind"]; sortOrder?: number }): Promise<{ category: ContentCategory }> {
    return this.request("/api/admin/categories", { method: "POST", body: input });
  }

  updateCategory(id: string, input: Partial<Pick<ContentCategory, "slug" | "name" | "kind" | "sortOrder">>): Promise<{ category: ContentCategory }> {
    return this.request(`/api/admin/categories/${encodeURIComponent(id)}`, { method: "PATCH", body: input });
  }

  adminItems(): Promise<AdminItemListResponse> {
    return this.request("/api/admin/items");
  }

  createItem(input: {
    key?: string;
    categoryId: string;
    kind?: ContentItem["kind"];
    english: string;
    meaning: string;
    pronunciation?: string;
    sortOrder?: number;
  }): Promise<{ item: ContentItem }> {
    return this.request("/api/admin/items", { method: "POST", body: input });
  }

  updateItem(id: string, input: Partial<Omit<ContentItem, "id" | "revision">>): Promise<{ item: ContentItem }> {
    return this.request(`/api/admin/items/${encodeURIComponent(id)}`, { method: "PATCH", body: input });
  }

  publishItem(id: string): Promise<{ item: ContentItem }> {
    return this.request(`/api/admin/items/${encodeURIComponent(id)}/publish`, { method: "POST" });
  }

  archiveItem(id: string): Promise<{ item: ContentItem }> {
    return this.request(`/api/admin/items/${encodeURIComponent(id)}/archive`, { method: "POST" });
  }

  publishCategory(id: string): Promise<{ category: ContentCategory }> {
    return this.request(`/api/admin/categories/${encodeURIComponent(id)}/publish`, { method: "POST" });
  }

  archiveCategory(id: string): Promise<{ category: ContentCategory }> {
    return this.request(`/api/admin/categories/${encodeURIComponent(id)}/archive`, { method: "POST" });
  }

  previewImport(csv: string): Promise<ImportPreviewResponse> {
    return this.request("/api/admin/imports/preview", { method: "POST", body: { csv } });
  }

  commitImport(importId: string): Promise<Record<string, unknown>> {
    return this.request("/api/admin/imports/commit", { method: "POST", body: { previewId: importId } });
  }

  audit(): Promise<AuditResponse> {
    return this.request("/api/admin/audit");
  }
}

export const api = new ApiClient();

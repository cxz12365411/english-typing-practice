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
  EmailCodePurpose,
  EmailCodeResponse,
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
  EMAIL_AUTH_DISABLED: "邮箱验证码功能尚未启用",
  EMAIL_DELIVERY_UNAVAILABLE: "邮箱验证码功能暂不可用，请稍后重试",
  SELF_REGISTRATION_DISABLED: "当前暂未开放邮箱注册",
  INVALID_EMAIL: "请输入有效的邮箱地址",
  INVALID_USERNAME: "账号需使用 3–32 位英文字母、数字、点、下划线或短横线",
  EMAIL_EXISTS: "该邮箱已经注册，请直接登录",
  EMAIL_ALREADY_BOUND: "当前账号已经绑定邮箱",
  EMAIL_NOT_BOUND: "当前账号尚未绑定邮箱",
  VERIFICATION_CODE_INVALID: "验证码不正确",
  VERIFICATION_CODE_EXPIRED: "验证码已过期，请重新获取",
  VERIFICATION_CODE_RATE_LIMITED: "验证码发送过于频繁，请稍后再试",
  VERIFICATION_CODE_ATTEMPTS_EXCEEDED: "验证码错误次数过多，请重新获取",
  VERIFICATION_SEND_FAILED: "验证码邮件发送失败，请稍后重试",
  INVALID_OR_EXPIRED_CODE: "验证码不正确或已过期，请重新获取",
  EMAIL_RATE_LIMITED: "验证码操作过于频繁，请稍后再试",
  EMAIL_DAILY_LIMIT_REACHED: "今日验证码发送额度已用完，请明天再试",
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
  NETWORK_ERROR: "无法连接服务器，请检查网络后重试",
  CSRF_INVALID: "安全校验已失效，请刷新页面后重试",
  AUTH_STATE_CHANGED: "登录账号状态已变化，请重新打开页面"
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
  private csrfRefreshPromise: Promise<SessionResponse> | null = null;

  setCsrfToken(token: string): void {
    this.csrfToken = token;
  }

  private async refreshCsrfToken(): Promise<SessionResponse> {
    if (!this.csrfRefreshPromise) {
      this.csrfRefreshPromise = this.request<SessionResponse>("/api/auth/session", {}, false)
        .then((session) => {
          this.setCsrfToken(session.csrfToken);
          return session;
        })
        .finally(() => { this.csrfRefreshPromise = null; });
    }
    return this.csrfRefreshPromise;
  }

  private anonymousCsrfRetryAllowed(path: string, options: RequestOptions): boolean {
    if (path === "/api/auth/email/request-code") {
      return (options.body as { purpose?: unknown } | undefined)?.purpose !== "bind_email";
    }
    return new Set([
      "/api/auth/login",
      "/api/auth/email/register",
      "/api/auth/email/login",
      "/api/auth/email/reset-password"
    ]).has(path);
  }

  async request<T>(path: string, options: RequestOptions = {}, allowCsrfRefresh = true): Promise<T> {
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
      if (
        allowCsrfRefresh &&
        method !== "GET" &&
        response.status === 403 &&
        code === "CSRF_INVALID" &&
        this.anonymousCsrfRetryAllowed(path, options)
      ) {
        const refreshed = await this.refreshCsrfToken();
        if (refreshed.user === null) return this.request<T>(path, options, false);
      }
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

  async requestEmailCode(
    email: string,
    purpose: EmailCodePurpose,
    expectedUserId: string | null
  ): Promise<EmailCodeResponse> {
    // Refresh the guest/session cookie so the returned challenge remains bound to
    // the same browser session for its full ten-minute lifetime.
    const session = await this.session();
    if ((session.user?.id ?? null) !== expectedUserId) {
      throw new ApiError(409, "AUTH_STATE_CHANGED", "Authentication state changed; reopen this page");
    }
    return this.request<EmailCodeResponse>("/api/auth/email/request-code", {
      method: "POST",
      body: { email, purpose }
    });
  }

  async loginWithEmail(email: string, challengeId: string, code: string): Promise<SessionResponse> {
    const response = await this.request<SessionResponse>("/api/auth/email/login", {
      method: "POST",
      body: { email, challengeId, code }
    });
    this.setCsrfToken(response.csrfToken);
    return response;
  }

  async registerWithEmail(input: {
    email: string;
    challengeId: string;
    code: string;
    username: string;
    displayName: string;
    password: string;
  }): Promise<SessionResponse> {
    const response = await this.request<SessionResponse>("/api/auth/email/register", {
      method: "POST",
      body: input
    });
    this.setCsrfToken(response.csrfToken);
    return response;
  }

  async resetPasswordWithEmail(email: string, challengeId: string, code: string, newPassword: string): Promise<SessionResponse> {
    const response = await this.request<SessionResponse>("/api/auth/email/reset-password", {
      method: "POST",
      body: { email, challengeId, code, newPassword }
    });
    this.setCsrfToken(response.csrfToken);
    return response;
  }

  async bindEmail(email: string, challengeId: string, code: string, currentPassword: string): Promise<SessionResponse> {
    const response = await this.request<SessionResponse>("/api/auth/email/bind", {
      method: "POST",
      body: { email, challengeId, code, currentPassword }
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

import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../src/api";

describe("practice attempt API", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("携带内容修订号，并为同一 payload 保留调用方提供的幂等 ID", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      attempt: {
        clientAttemptId: "attempt-fixed-id",
        itemId: "item-1",
        itemRevision: 7,
        correct: true,
        completedAt: "2026-09-04T00:00:00.000Z"
      },
      summary: { done: 1, correct: 1, accuracy: 1, streak: 1, mistakes: 0 }
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    api.setCsrfToken("csrf-test-token");

    await api.attempt("session-1", {
      clientAttemptId: "attempt-fixed-id",
      itemId: "item-1",
      itemRevision: 7,
      answer: "apple",
      durationMs: 320,
      occurredAt: "2026-09-04T00:00:00.000Z"
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toMatchObject({
      clientAttemptId: "attempt-fixed-id",
      itemId: "item-1",
      itemRevision: 7
    });
    expect(new Headers(init.headers).get("X-CSRF-Token")).toBe("csrf-test-token");
  });
});

describe("email authentication API", () => {
  const challengeId = "11111111-1111-4111-8111-111111111111";
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("请求验证码时只发送邮箱和用途，并携带 CSRF", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        user: null,
        csrfToken: "csrf-email-fresh",
        capabilities: { emailAuthEnabled: true, selfRegistrationEnabled: true }
      }), { status: 200, headers: { "Content-Type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        ok: true,
        challengeId,
        retryAfterSeconds: 60
      }), { status: 202, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    api.setCsrfToken("csrf-email-token");

    await api.requestEmailCode("learner@example.com", "login", null);

    const [path, init] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(path).toBe("/api/auth/email/request-code");
    expect(JSON.parse(String(init.body))).toEqual({ email: "learner@example.com", purpose: "login" });
    expect(new Headers(init.headers).get("X-CSRF-Token")).toBe("csrf-email-fresh");
  });

  it("访客 CSRF 过期时刷新会话并安全重试原请求一次", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        user: null,
        csrfToken: "csrf-before-expiry",
        capabilities: { emailAuthEnabled: true, selfRegistrationEnabled: true }
      }), { status: 200, headers: { "Content-Type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        error: { code: "CSRF_INVALID", message: "expired" }
      }), { status: 403, headers: { "Content-Type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        user: null,
        csrfToken: "csrf-refreshed",
        capabilities: { emailAuthEnabled: true, selfRegistrationEnabled: true }
      }), { status: 200, headers: { "Content-Type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        ok: true,
        challengeId,
        retryAfterSeconds: 60
      }), { status: 202, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    api.setCsrfToken("csrf-expired");

    await api.requestEmailCode("learner@example.com", "login", null);

    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(fetchMock.mock.calls.map(([path]) => path)).toEqual([
      "/api/auth/session",
      "/api/auth/email/request-code",
      "/api/auth/session",
      "/api/auth/email/request-code"
    ]);
    const retryHeaders = new Headers((fetchMock.mock.calls[3]![1] as RequestInit).headers);
    expect(retryHeaders.get("X-CSRF-Token")).toBe("csrf-refreshed");
    expect(JSON.parse(String((fetchMock.mock.calls[3]![1] as RequestInit).body))).toEqual({
      email: "learner@example.com",
      purpose: "login"
    });
  });

  it("刷新后身份已变化时绝不以另一个账号重放写请求", async () => {
    const csrfFailure = new Response(JSON.stringify({
      error: { code: "CSRF_INVALID", message: "expired" }
    }), { status: 403, headers: { "Content-Type": "application/json" } });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        user: null,
        csrfToken: "csrf-before-account-change",
        capabilities: { emailAuthEnabled: true, selfRegistrationEnabled: true }
      }), { status: 200, headers: { "Content-Type": "application/json" } }))
      .mockResolvedValueOnce(csrfFailure)
      .mockResolvedValueOnce(new Response(JSON.stringify({
        user: {
          id: "different-user",
          username: "other.admin",
          displayName: "Other Admin",
          role: "admin",
          status: "active",
          mustChangePassword: false,
          createdAt: "2026-09-04T00:00:00.000Z"
        },
        csrfToken: "csrf-for-different-user",
        capabilities: { emailAuthEnabled: true, selfRegistrationEnabled: true }
      }), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    api.setCsrfToken("csrf-from-old-tab");

    await expect(api.requestEmailCode("learner@example.com", "login", null)).rejects.toMatchObject({
      status: 403,
      code: "CSRF_INVALID"
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls.map(([path]) => path)).toEqual([
      "/api/auth/session",
      "/api/auth/email/request-code",
      "/api/auth/session"
    ]);
  });

  it("主动刷新发现账号已切换时不会替新账号申请绑定挑战", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      user: {
        id: "different-user",
        username: "other.user",
        displayName: "Other User",
        role: "user",
        status: "active",
        mustChangePassword: false,
        createdAt: "2026-09-04T00:00:00.000Z"
      },
      csrfToken: "csrf-for-different-user",
      capabilities: { emailAuthEnabled: true, selfRegistrationEnabled: true }
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(api.requestEmailCode("new-binding@example.com", "bind_email", "original-user")).rejects.toMatchObject({
      status: 409,
      code: "AUTH_STATE_CHANGED"
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]![0]).toBe("/api/auth/session");
  });

  it.each([
    {
      name: "验证码登录",
      invoke: () => api.loginWithEmail("learner@example.com", challengeId, "123456"),
      path: "/api/auth/email/login",
      body: { email: "learner@example.com", challengeId, code: "123456" }
    },
    {
      name: "注册",
      invoke: () => api.registerWithEmail({
        email: "learner@example.com",
        challengeId,
        code: "123456",
        username: "learner",
        displayName: "学习者",
        password: "correct horse battery"
      }),
      path: "/api/auth/email/register",
      body: {
        email: "learner@example.com",
        challengeId,
        code: "123456",
        username: "learner",
        displayName: "学习者",
        password: "correct horse battery"
      }
    },
    {
      name: "验证码改密",
      invoke: () => api.resetPasswordWithEmail("learner@example.com", challengeId, "123456", "new password 123"),
      path: "/api/auth/email/reset-password",
      body: { email: "learner@example.com", challengeId, code: "123456", newPassword: "new password 123" }
    },
    {
      name: "绑定邮箱",
      invoke: () => api.bindEmail("learner@example.com", challengeId, "123456", "current password"),
      path: "/api/auth/email/bind",
      body: { email: "learner@example.com", challengeId, code: "123456", currentPassword: "current password" }
    }
  ])("$name 使用约定的接口且不会调用本地存储", async ({ invoke, path, body }) => {
    const response = {
      user: {
        id: "user-1",
        username: "learner",
        displayName: "学习者",
        role: "user",
        status: "active",
        mustChangePassword: false,
        email: "learner@example.com",
        emailVerified: true,
        createdAt: "2026-09-04T00:00:00.000Z"
      },
      csrfToken: "rotated-token",
      capabilities: { emailAuthEnabled: true, selfRegistrationEnabled: true }
    };
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(response), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    }));
    const storageWrite = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("localStorage", { setItem: storageWrite });
    api.setCsrfToken("csrf-email-token");

    await invoke();

    const [actualPath, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(actualPath).toBe(path);
    expect(JSON.parse(String(init.body))).toEqual(body);
    expect(storageWrite).not.toHaveBeenCalled();
  });
});

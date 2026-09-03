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

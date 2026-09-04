import { describe, expect, it } from "vitest";
import { ApiError } from "../src/api";
import {
  normalizeEmail,
  normalizeRetryAfterSeconds,
  retryAfterFromError,
  validateEmail,
  validateVerificationCode
} from "../src/email";

describe("email helpers", () => {
  it("规范化邮箱但不会改写邮箱内部内容", () => {
    expect(normalizeEmail("  Learner+One@Example.COM ")).toBe("learner+one@example.com");
  });

  it("拒绝空值、缺少域名及超长邮箱", () => {
    expect(validateEmail("")).toContain("邮箱");
    expect(validateEmail("learner@example")).toContain("有效");
    expect(validateEmail("Learner <learner@example.com>")).toContain("有效");
    expect(validateEmail("a..b@example.com")).toContain("有效");
    expect(validateEmail(`${"a".repeat(245)}@example.com`)).toContain("254");
    expect(validateEmail("learner@example.com")).toBeNull();
  });

  it("将服务端冷却时间限制在安全范围", () => {
    expect(normalizeRetryAfterSeconds(undefined)).toBe(60);
    expect(normalizeRetryAfterSeconds(1.2)).toBe(2);
    expect(normalizeRetryAfterSeconds(99_999)).toBe(900);
  });

  it("验证码必须是六位数字", () => {
    expect(validateVerificationCode("123456")).toBeNull();
    expect(validateVerificationCode("12345")).toContain("6 位");
    expect(validateVerificationCode("12a456")).toContain("数字");
  });

  it("从限流错误读取重试时间", () => {
    const error = new ApiError(429, "VERIFICATION_CODE_RATE_LIMITED", "稍后再试", { retryAfterSeconds: 37 });
    expect(retryAfterFromError(error)).toBe(37);
    expect(retryAfterFromError(new Error("network"))).toBeNull();
  });
});

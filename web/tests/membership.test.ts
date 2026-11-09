import { describe, expect, it } from "vitest";
import { safePaymentUrl, membershipLabel, displayDate } from "../src/membership";
import { normaliseAppRoute } from "../src/routes";
import type { MembershipResponse } from "../src/types";

describe("membership checkout boundaries", () => {
  it("only links to the official checkout for the selected environment", () => {
    expect(safePaymentUrl("https://openapi.alipay.com/gateway.do?a=b", "live")).toContain("openapi.alipay.com");
    expect(safePaymentUrl("https://openapi-sandbox.dl.alipaydev.com/gateway.do", "sandbox")).toBeTruthy();
    for (const bad of ["javascript:alert(1)", "https://openapi.alipay.com.evil.test/", "https://attacker@openapi.alipay.com/", "http://openapi.alipay.com/", "https://openapi.alipay.com:8443/", "https://evil.test/"]) expect(safePaymentUrl(bad, "live")).toBeNull();
    expect(safePaymentUrl("https://openapi.alipay.com/gateway.do", "sandbox")).toBeNull();
    expect(safePaymentUrl("https://openapi.alipay.com/gateway.do", "test")).toBeNull();
  });
  it("retains an order ID, but never return-page payment or redirect claims", () => {
    expect(normaliseAppRoute("/membership?order=order-123&status=paid&return=https://evil.test", "https://app.test", "/login")).toBe("/membership?order=order-123");
    for (const query of ["order=x&order=y", "order=%2Fetc", "order=", "status=paid"]) expect(normaliseAppRoute(`/membership?${query}`, "https://app.test", "/login")).toBe("/membership");
  });
  it("does not show trial claims when enforcement is disabled", () => {
    expect(membershipLabel({ enabled: false, access: { status: "expired" } } as MembershipResponse)).toBe("当前免费开放");
    expect(displayDate("invalid")).toBe("—");
  });
});

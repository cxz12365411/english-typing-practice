import { describe, expect, it } from "vitest";
import { normaliseAppRoute, practiceBatchId } from "../src/routes";

const origin = "https://example.test";
describe("practice batch route handling", () => {
  it("retains only an internal practice batch and drops unrelated parameters", () => {
    expect(normaliseAppRoute("/practice?batch=batch-123&admin=1#ignored", origin, "/login")).toBe("/practice?batch=batch-123");
    expect(normaliseAppRoute("/admin?batch=x", origin, "/login")).toBe("/admin");
    expect(normaliseAppRoute("https://evil.test/practice?batch=x", origin, "/login")).toBe("/login");
  });
  it("never turns an invalid batch selection into full-bank practice", () => {
    expect(normaliseAppRoute("/practice?batch=a&batch=b", origin, "/login")).toBe("/practice?batch=");
    for (const query of ["?batch=", "?batch=a&batch=b", "?batch=%2Fetc", `?batch=${"x".repeat(101)}`]) {
      expect(() => practiceBatchId(query)).toThrow("链接无效");
    }
  });
  it("supports normal and valid batch practice", () => {
    expect(practiceBatchId("")).toBeUndefined();
    expect(practiceBatchId("?batch=batch-123")).toBe("batch-123");
    expect(normaliseAppRoute("/practice", origin, "/login")).toBe("/practice");
  });
});

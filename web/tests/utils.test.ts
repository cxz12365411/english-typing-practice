import { describe, expect, it } from "vitest";
import type { ContentItem } from "../src/types";
import {
  buildPracticePool,
  escapeHtml,
  normalizeAnswer,
  parseLegacyMistakes,
  shuffle,
  shouldRefreshContentForAttemptError,
  validatePassword
} from "../src/utils";

const items: ContentItem[] = [
  { id: "1", key: "apple", kind: "word", categoryId: "a", english: "apple", meaning: "苹果", pronunciation: "艾剖", sortOrder: 1, revision: 1 },
  { id: "2", key: "banana", kind: "word", categoryId: "a", english: "banana", meaning: "香蕉", pronunciation: "波那那", sortOrder: 2, revision: 1 },
  { id: "3", key: "hello", kind: "sentence", categoryId: "b", english: "How are you?", meaning: "你好吗？", pronunciation: "好啊油", sortOrder: 1, revision: 1 }
];

describe("normalizeAnswer", () => {
  it("忽略首尾空白、连续空格和英文大小写", () => {
    expect(normalizeAnswer("  HOW   are You?  ")).toBe("how are you?");
    expect(normalizeAnswer("I’m  READY")).toBe("i'm ready");
  });
});

describe("parseLegacyMistakes", () => {
  it("只保留去重后的非空字符串", () => {
    expect(parseLegacyMistakes('[" apple ","apple",42,"banana",""]')).toEqual(["apple", "banana"]);
  });

  it("损坏或非数组数据安全返回空列表", () => {
    expect(parseLegacyMistakes("not-json")).toEqual([]);
    expect(parseLegacyMistakes('{"word":"apple"}')).toEqual([]);
  });
});

describe("buildPracticePool", () => {
  it("按分类筛选并保留顺序", () => {
    expect(buildPracticePool(items, "a", "order", new Set()).map((item) => item.id)).toEqual(["1", "2"]);
  });

  it("错题模式只保留账号错题", () => {
    expect(buildPracticePool(items, "all", "mistakes", new Set(["2", "3"])).map((item) => item.id)).toEqual(["2", "3"]);
  });

  it("随机模式返回同样成员且不修改原数组", () => {
    const before = items.map((item) => item.id);
    const shuffled = shuffle(items, () => 0);
    expect(shuffled.map((item) => item.id).sort()).toEqual(before.slice().sort());
    expect(items.map((item) => item.id)).toEqual(before);
  });
});

describe("validatePassword", () => {
  it("执行 12 到 128 字符边界", () => {
    expect(validatePassword("short")).toContain("12");
    expect(validatePassword("a".repeat(12))).toBeNull();
    expect(validatePassword("a".repeat(128))).toBeNull();
    expect(validatePassword("a".repeat(129))).toContain("128");
  });
});

describe("escapeHtml", () => {
  it("转义服务器可控文本", () => {
    expect(escapeHtml('<img src=x onerror="x">')).toBe("&lt;img src=x onerror=&quot;x&quot;&gt;");
  });
});

describe("shouldRefreshContentForAttemptError", () => {
  it("内容修订冲突不进入普通网络重试", () => {
    expect(shouldRefreshContentForAttemptError("CONTENT_CHANGED")).toBe(true);
    expect(shouldRefreshContentForAttemptError("CONTENT_UNAVAILABLE")).toBe(true);
    expect(shouldRefreshContentForAttemptError("NETWORK_ERROR")).toBe(false);
    expect(shouldRefreshContentForAttemptError("ATTEMPT_RATE_LIMITED")).toBe(false);
  });
});

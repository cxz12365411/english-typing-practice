import assert from "node:assert/strict";
import test from "node:test";
import { parseSentenceMarkdown } from "../src/content-parser.js";

test("two-column sentence Markdown preserves legacy keys, category order and pronunciation", () => {
  const parsed = parseSentenceMarkdown([
    "## 1. First category",
    "| English | 中文 |",
    "|---|---|",
    "| Hello.<br>中文谐音：哈喽 | 你好。 |",
    "| Goodbye. | 再见。 |",
    "## 2. Second category",
    "| English | 中文 |",
    "|---|---|",
    "| Thank you. | 谢谢。 |"
  ].join("\r\n"));
  assert.deepEqual(parsed.categories.map(({ slug, sortOrder }) => ({ slug, sortOrder })), [
    { slug: "sentences-1", sortOrder: 1 },
    { slug: "sentences-2", sortOrder: 2 }
  ]);
  assert.deepEqual(parsed.items.map(({ key, categorySlug, sortOrder }) => ({ key, categorySlug, sortOrder })), [
    { key: "sentence-0001", categorySlug: "sentences-1", sortOrder: 1 },
    { key: "sentence-0002", categorySlug: "sentences-1", sortOrder: 2 },
    { key: "sentence-0003", categorySlug: "sentences-2", sortOrder: 1 }
  ]);
  assert.equal(parsed.items[0]!.english, "Hello.");
  assert.equal(parsed.items[0]!.meaning, "你好。");
  assert.equal(parsed.items[0]!.pronunciation, "哈喽");
});

test("explicit sentence keys preserve existing identities when earlier categories gain rows", () => {
  const parsed = parseSentenceMarkdown([
    "## 1. First category",
    "| English | 中文 | Stable ID |",
    "|---|---|---|",
    "| Original first. | 原有第一句。 | sentence-0001 |",
    "| New phrase. | 新增句子。 | sentence-0003 |",
    "## 2. Second category",
    "| English | 中文 | Stable ID |",
    "|---|---|---|",
    "| Original second.<br>中文谐音：测试谐音 | 原有第二句。 | sentence-0002 |"
  ].join("\n"));
  assert.deepEqual(parsed.items.map(({ key, categorySlug, sortOrder }) => ({ key, categorySlug, sortOrder })), [
    { key: "sentence-0001", categorySlug: "sentences-1", sortOrder: 1 },
    { key: "sentence-0003", categorySlug: "sentences-1", sortOrder: 2 },
    { key: "sentence-0002", categorySlug: "sentences-2", sortOrder: 1 }
  ]);
  assert.equal(parsed.items[2]!.pronunciation, "测试谐音");
});

test("mixed two- and three-column sentence tables keep both legacy and explicit keys", () => {
  const parsed = parseSentenceMarkdown("## 1. Mixed\n| Legacy. | 原有。 |\n| Added. | 新增。 | sentence-01000 |\n| Legacy next. | 原有下一句。 |");
  assert.deepEqual(parsed.items.map((item) => item.key), ["sentence-0001", "sentence-01000", "sentence-0003"]);
});

test("explicit sentence keys must be positive sentence IDs with at least four digits", () => {
  for (const key of ["", "word-0001", "sentence-123", "sentence-0000", "sentence-00000", "sentence--001", "sentence-00x1", "sentence-0001extra"]) {
    assert.throws(
      () => parseSentenceMarkdown(`## 1. Invalid\n| Invalid. | 无效。 | ${key} |`),
      /Invalid sentence item key/,
      `should reject ${JSON.stringify(key)}`
    );
  }
});

test("duplicate explicit sentence keys are rejected even across categories", () => {
  assert.throws(
    () => parseSentenceMarkdown("## 1. First\n| First. | 第一。 | sentence-0100 |\n## 2. Second\n| Second. | 第二。 | sentence-0100 |"),
    /Duplicate sentence item key: sentence-0100/
  );
});

test("explicit sentence keys cannot reuse an earlier implicit key", () => {
  assert.throws(
    () => parseSentenceMarkdown("## 1. Mixed\n| Legacy. | 原有。 |\n| Added. | 新增。 | sentence-0001 |"),
    /Duplicate sentence item key: sentence-0001/
  );
});

test("implicit sentence keys cannot reuse an earlier explicit key", () => {
  assert.throws(
    () => parseSentenceMarkdown("## 1. Mixed\n| Added. | 新增。 | sentence-0002 |\n| Legacy. | 原有。 |"),
    /Duplicate sentence item key: sentence-0002/
  );
});

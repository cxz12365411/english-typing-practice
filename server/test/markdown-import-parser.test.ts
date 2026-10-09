import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { normalizeMarkdownCategoryTitle, parseMarkdownImport } from "../src/markdown-import-parser.js";

const tableHeader = "| 英文 | 中文释义 | 中文谐音 |\n|---|---|---|";
const simple = `## 1. 句型：日常交流\n${tableHeader}\n| Hello. | 你好。 | 哈喽。 |`;

test("Markdown import parses all 850 existing words without changing source text or order", () => {
  const markdown = readFileSync(new URL("../../basic-english-850.md", import.meta.url), "utf8");
  const parsed = parseMarkdownImport(markdown);
  assert.deepEqual(parsed.errors, []);
  assert.deepEqual(parsed.warnings, []);
  assert.equal(parsed.rows.length, 850);
  assert.equal(parsed.groups.length, 4);
  assert.equal(parsed.groups[0]!.title, "操作/功能词");
  assert.ok(parsed.groups.every((group) => group.kind === "word"));
  assert.deepEqual(parsed.rows[0], { row: 9, groupId: "group-7", english: "come", meaning: "来；过来", pronunciation: "卡姆" });
  assert.ok(parsed.ignoredCount >= 2);
});

test("Markdown import parses the existing 206 sentence corpus and ignores Stable IDs", () => {
  const markdown = readFileSync(new URL("../../daily-english-high-frequency-sentences.md", import.meta.url), "utf8");
  const parsed = parseMarkdownImport(markdown);
  assert.deepEqual(parsed.errors, []);
  assert.deepEqual(parsed.warnings, []);
  assert.equal(parsed.rows.length, 206);
  assert.equal(parsed.groups.length, 18);
  assert.ok(parsed.groups.every((group) => group.kind === "sentence"));
  assert.equal(parsed.rows[0]!.english, "Hi, how are you?");
  assert.equal(parsed.rows[0]!.pronunciation, "嗨， 好 阿 尤？");
  assert.ok(parsed.rows.some((item) => item.english === "I won't post the photos without your permission."));
  assert.ok(parsed.rows.every((item) => !Object.hasOwn(item, "key")));
});

// Portable fixture of the original street-photography file (not a dependency on
// a user's private Documents directory). Tertiary headings are item captions.
const streetSections = [
  ["一、开场，征求同意", [
    ["Hi, excuse me. I'm a street photographer.", "你好，打扰一下。我是一名街头摄影师。", "嗨，伊克斯丘兹 米。艾姆 额 斯垂特 佛塔格若弗。"],
    ["I really like your style.", "我很喜欢你的风格。", "艾 瑞利 赖克 尤尔 斯代尔。"],
    ["Could I take a photo of you?", "我可以给你拍张照片吗？", "库德 艾 特诶克 额 佛头 阿夫 优？"],
    ["It'll only take a minute.", "只需要一分钟。", "伊特尔 欧恩利 特诶克 额 米尼特。"]
  ]],
  ["二、拍摄时，引导动作", [
    ["Could you stand here, please?", "可以请你站在这里吗？", "库德 优 斯坦德 希尔，普利兹？"],
    ["Turn a little this way, please.", "请稍微往这边转一点。", "特恩 额 利特尔 迪斯 韦，普利兹。"],
    ["Look over there.", "看向那边。", "卢克 欧弗 戴尔。"],
    ["Just relax and be yourself.", "放轻松，自然一点就好。", "贾斯特 瑞拉克斯 安德 比 尤尔塞尔夫。"],
    ["Perfect! That looks great.", "非常好！这样很好看。", "珀菲克特！戴特 卢克斯 格瑞特。"]
  ]],
  ["三、拍完后，看图和发照片", [
    ["Would you like to see the photos?", "你想看看照片吗？", "伍德 优 赖克 特 西 德 佛头兹？"],
    ["How can I send you the photos?", "我怎么把照片发给你？", "豪 肯 艾 森德 优 德 佛头兹？"],
    ["Is it okay if I post these on Instagram?", "我可以把这几张照片发到 Instagram 上吗？", "伊兹 伊特 欧凯 伊夫 艾 波斯特 迪兹 昂 因斯特格拉姆？"]
  ]],
  ["四、礼貌结束", [
    ["Thanks for your time. Have a great day!", "谢谢你抽出时间，祝你今天愉快！", "桑克斯 佛 尤尔 泰姆。海夫 额 格瑞特 得诶！"],
    ["No worries. Have a nice day!", "没关系，祝你今天愉快！", "诺 沃瑞兹。海夫 额 奈斯 得诶！"]
  ]]
] as const;

test("Markdown import parses all 14 original street paragraphs with four groups", () => {
  const markdown = "# 街头摄影英语交流语句\n\n" + streetSections.map(([title, items]) =>
    `## ${title}\n\n` + items.map(([english, meaning, pronunciation], index) =>
      `### ${index + 1}. 题目说明\n\n**${english}**  \n谐音：${pronunciation}  \n中文：${meaning}\n`).join("\n")
  ).join("\n") + "\n先背熟第 1、2、3 句。";
  const parsed = parseMarkdownImport(markdown);
  assert.deepEqual(parsed.errors, []);
  assert.deepEqual(parsed.warnings, []);
  assert.equal(parsed.rows.length, 14);
  assert.equal(parsed.groups.length, 4);
  assert.equal(parsed.groups[0]!.title, "开场,征求同意");
  assert.deepEqual(parsed.rows.map(({ english }) => english), streetSections.flatMap(([, entries]) => entries.map(([english]) => english)));
  assert.equal(parsed.ignoredCount, 1);
});

test("standard named columns may be reordered, use aliases, omit outer pipes and support BOM/CRLF", () => {
  const parsed = parseMarkdownImport("\uFEFF# 交流\r\nPronunciation | Meaning | English\r\n--- | --- | ---\r\n哈喽 | 你好 | Hello\r\n英格利什 | 英语 | English\r\n");
  assert.deepEqual(parsed.errors, []);
  assert.deepEqual(parsed.rows.map(({ english, meaning, pronunciation }) => ({ english, meaning, pronunciation })), [
    { english: "Hello", meaning: "你好", pronunciation: "哈喽" },
    { english: "English", meaning: "英语", pronunciation: "英格利什" }
  ]);
  assert.equal(parsed.groups[0]!.groupId, "group-0");
  assert.equal(parsed.groups[0]!.row, 1);
});

test("escaped pipes and backslashes are decoded without altering other escapes", () => {
  const parsed = parseMarkdownImport(`## Symbols\n${tableHeader}\n| A \\| B | 甲\\|乙 | 测试 |\n| C:\\\\temp | 路径 | 西 |\n| slash\\ntext | 原样 | 测试 |`);
  assert.deepEqual(parsed.errors, []);
  assert.deepEqual(parsed.rows.map(({ english }) => english), ["A | B", "C:\\temp", "slash\\ntext"]);
  assert.equal(parsed.rows[0]!.meaning, "甲|乙");
});

test("category names normalize NFKC, ordinals, one type prefix, counts and spaces", () => {
  assert.equal(normalizeMarkdownCategoryTitle("  １． 单词： 操作/功能词 100 个  "), "操作/功能词");
  assert.equal(normalizeMarkdownCategoryTitle("（二） 句型：  日常   交流 "), "日常 交流");
  assert.equal(normalizeMarkdownCategoryTitle("三、句型：街头摄影：开场"), "街头摄影:开场");
  assert.equal(normalizeMarkdownCategoryTitle("句型：句型：保留第二个前缀"), "句型:保留第二个前缀");
  assert.equal(normalizeMarkdownCategoryTitle("单词故事"), "单词故事");
  assert.equal(normalizeMarkdownCategoryTitle("第一部分 单词：旅行"), "旅行");
});

test("H1, filename then user title are fallback categories; H3 is not a group", () => {
  const records = "### ignored caption\n**Hello.**\n中文：你好。";
  assert.equal(parseMarkdownImport(`# My title\n${records}`, { fileName: "other.md" }).groups[0]!.title, "My title");
  assert.equal(parseMarkdownImport(records, { fileName: "C:\\fakepath\\my-words.MARKDOWN", defaultCategoryName: "ignored" }).groups[0]!.title, "my-words");
  assert.equal(parseMarkdownImport(records, { defaultCategoryName: "我的分类" }).groups[0]!.title, "我的分类");
  assert.equal(parseMarkdownImport(records, { fileName: "", defaultCategoryName: "备用名称" }).groups[0]!.title, "备用名称");
  assert.ok(parseMarkdownImport(records).errors.some(({ field }) => field === "category"));
});

test("H2 wins over H1, repeated section names preserve group identity, empty sections do not import", () => {
  const parsed = parseMarkdownImport("# 文档\n## 1. 无题目\n说明文字\n## 2. 内容\n**One.**\n中文：一。\n## 3. 内容\n**Two.**\n中文：二。\n");
  assert.deepEqual(parsed.errors, []);
  assert.deepEqual(parsed.groups.map(({ groupId, title }) => ({ groupId, title })), [{ groupId: "group-4", title: "内容" }, { groupId: "group-7", title: "内容" }]);
  assert.equal(parsed.ignoredCount, 1);
});

test("explicit category type overrides syntax, but a mixed implicit group reports ambiguity", () => {
  const mixed = `- **come**：来\n${tableHeader}\n| Go. | 走。 | 构 |`;
  assert.ok(parseMarkdownImport(`## 混合\n${mixed}`).errors.some(({ field }) => field === "kind"));
  for (const [prefix, kind] of [["单词", "word"], ["句型", "sentence"]] as const) {
    const parsed = parseMarkdownImport(`## 1. ${prefix}：明确类型\n${mixed}`);
    assert.deepEqual(parsed.errors, []);
    assert.equal(parsed.groups[0]!.kind, kind);
  }
  assert.equal(parseMarkdownImport(`# 单词：词汇\n${tableHeader}\n| Hi | 嗨 | 嗨 |`).groups[0]!.kind, "word");
});

test("missing meaning is an error, missing pronunciation only a warning with accurate row", () => {
  const parsed = parseMarkdownImport("## Test\n- **hello**：\n- **goodbye**：再见\n");
  assert.deepEqual(parsed.errors.map(({ row, field }) => ({ row, field })), [{ row: 2, field: "meaning" }]);
  assert.deepEqual(parsed.warnings.map(({ row, field }) => ({ row, field })), [{ row: 2, field: "pronunciation" }, { row: 3, field: "pronunciation" }]);
  assert.equal(parsed.rows.length, 2);
});

test("malformed recognizable records, orphan fields, and duplicate metadata fail explicitly", () => {
  const parsed = parseMarkdownImport("## 句型：Test\n中文：孤立释义\n- **missing-colon**\n**missing-close\n**Hello.**\n中文：你好\n中文：另一译文\n谐音：哈喽\n谐音：重复\n");
  assert.deepEqual(parsed.errors.map(({ row }) => row), [2, 3, 4, 7, 9]);
  assert.equal(parsed.rows[0]!.meaning, "你好");
  assert.equal(parsed.rows[0]!.pronunciation, "哈喽");
});

test("tables reject invalid headers, missing separators, duplicate columns, wrong column counts and empty required values", () => {
  for (const markdown of [
    "| English | Unknown |\n|---|---|\n| Hello | 内容 |",
    "| English | 中文 |\n| Hello | 你好 |",
    "| English | English | 中文 |\n|---|---|---|\n| Hi | Hi | 嗨 |",
    "| Hello | 你好 |",
    `${tableHeader}\n| Hello | 你好 | 未转义 | 多余列 |`,
    `${tableHeader}\n| | 你好 | 哈喽 |`,
    `${tableHeader}\n| Hello | | 哈喽 |`
  ]) assert.ok(parseMarkdownImport(`## Test\n${markdown}`).errors.length > 0, markdown);
});

test("Stable ID is never an import key; embedded br pronunciation is compatible but conflicting values fail", () => {
  const parsed = parseMarkdownImport("## Test\n| English / 中文谐音 | 中文 | Stable ID |\n|---|---|---|\n| Hi.<BR />中文谐音：嗨 | 你好 | arbitrary-invalid-id |\n| Bye.<br>谐音：拜 | 再见 | same-id |\n");
  assert.deepEqual(parsed.errors, []);
  assert.deepEqual(parsed.rows.map(({ pronunciation }) => pronunciation), ["嗨", "拜"]);
  assert.equal(JSON.stringify(parsed.rows).includes("arbitrary-invalid-id"), false);
  assert.ok(parseMarkdownImport(`## Test\n${tableHeader}\n| Hi.<br>中文谐音：嗨 | 你好 | 哈喽 |`).errors.some(({ field }) => field === "pronunciation"));
});

test("HTML, script and links stay literal text; fences are ignored and no sentence splitting occurs", () => {
  const english = "<script>alert(1)</script> [hello](https://example.invalid/collect)";
  const parsed = parseMarkdownImport(`## Test\n${tableHeader}\n| ${english} | <img src=x onerror=alert(1)> | 谐音 |\n| First. Second? | 一。二？ | 一二 |\n\n\`\`\`md\n## Not a category\n- **ignored**：不导入\n\`\`\``);
  assert.deepEqual(parsed.errors, []);
  assert.equal(parsed.rows[0]!.english, english);
  assert.equal(parsed.rows[0]!.meaning, "<img src=x onerror=alert(1)>");
  assert.equal(parsed.rows[1]!.english, "First. Second?");
  assert.equal(parsed.rows.length, 2);
  assert.equal(parsed.groups.length, 1);
  assert.equal(parsed.ignoredCount, 4);
});

test("invalid Unicode and control characters are rejected with source locations", () => {
  for (const value of ["bad\uFFFD", "bad\u0000", "bad\uD800"]) {
    const parsed = parseMarkdownImport(`## Test\n- **${value}**：内容`);
    assert.ok(parsed.errors.some(({ row, field }) => row === 2 && field === "markdown"));
  }
  assert.deepEqual(parseMarkdownImport("## Emoji\n- **hi**：你好 😀").errors, []);
});

test("recognizable metadata with a missing colon is an explicit format error", () => {
  const parsed = parseMarkdownImport("## Test\n**Hello.**\n中文：你好\n谐音 哈喽");
  assert.ok(parsed.errors.some(({ row, field }) => row === 4 && field === "format"));
});

test("per-field length limits are enforced without silently truncating content", () => {
  const parsed = parseMarkdownImport(`## Test\n${tableHeader}\n| ${"a".repeat(501)} | ${"中".repeat(1001)} | ${"音".repeat(501)} |`);
  assert.deepEqual(parsed.errors.map(({ field }) => field), ["english", "meaning", "pronunciation"]);
  assert.equal(parsed.rows[0]!.english.length, 501);
  const boundary = parseMarkdownImport(`## Test\n${tableHeader}\n| ${"a".repeat(500)} | ${"中".repeat(1000)} | ${"音".repeat(500)} |`);
  assert.deepEqual(boundary.errors, []);
});

test("byte limit uses UTF-8 bytes, not JS character count", () => {
  const parsed = parseMarkdownImport("中".repeat(350000));
  assert.equal(parsed.rows.length, 0);
  assert.match(parsed.errors[0]!.message, /1 MiB/);
});

test("5000 records are accepted; the 5001st is an error and parsing is bounded", () => {
  const input = "## Test\n" + Array.from({ length: 5000 }, (_, index) => `- **word${index}**：词\n  - 中文谐音：词`).join("\n");
  const parsed = parseMarkdownImport(input);
  assert.deepEqual(parsed.errors, []);
  assert.equal(parsed.rows.length, 5000);
  const oversized = parseMarkdownImport(`${input}\n- **extra**：多余`);
  assert.equal(oversized.rows.length, 5000);
  assert.match(oversized.errors[0]!.message, /5000/);
});

test("empty and prose-only documents explain that no importable records were found", () => {
  for (const input of ["", "# Notes\n说明文字\n[link](https://example.invalid)"]) {
    const parsed = parseMarkdownImport(input);
    assert.equal(parsed.rows.length, 0);
    assert.match(parsed.errors[0]!.message, /没有识别到题目/);
  }
});

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { parseSentenceMarkdown, parseWordMarkdown } from "../src/content-parser.js";

interface StaticItem {
  word: string;
  meaning: string;
  sound: string;
  category: string;
  kind: "word" | "sentence";
}

const wordMarkdown = readFileSync(new URL("../../basic-english-850.md", import.meta.url), "utf8");
const sentenceMarkdown = readFileSync(new URL("../../daily-english-high-frequency-sentences.md", import.meta.url), "utf8");
const canonicalWords = parseWordMarkdown(wordMarkdown);
const canonicalSentences = parseSentenceMarkdown(sentenceMarkdown);
const categoryNames = new Map([...canonicalWords.categories, ...canonicalSentences.categories]
  .map((category) => [category.slug, category.name]));
const streetCounts = [
  ["句型：街头摄影：开场与征求同意", 18],
  ["句型：街头摄影：拍摄时引导动作", 19],
  ["句型：街头摄影：看图和发送照片", 17],
  ["句型：街头摄影：礼貌结束", 16]
] as const;
const barCounts = [
  ["句型：酒吧社交：开场与轻松夸赞", 8],
  ["句型：酒吧社交：点酒与碰杯", 8],
  ["句型：酒吧社交：闲聊与邀请", 8],
  ["句型：酒吧社交：交换联系方式与礼貌结束", 8]
] as const;

function parserSource(html: string): string {
  // Run the actual standalone parsers, not a test copy. The slice ends before
  // the UI helpers, so the isolated context needs neither a DOM nor a browser.
  const start = html.indexOf("    function parseWords(markdown) {");
  const end = html.indexOf("    function shuffle(items) {", start);
  assert.ok(start >= 0 && end > start, "standalone parser functions must be present");
  return html.slice(start, end);
}

function parseStandalone(source: string, words: string, sentences: string): { words: StaticItem[]; sentences: StaticItem[] } {
  const result = runInNewContext(
    `${source}\nJSON.stringify({ words: parseWords(wordMarkdown), sentences: parseSentences(sentenceMarkdown) });`,
    { wordMarkdown: words, sentenceMarkdown: sentences },
    { timeout: 1000 }
  ) as string;
  // JSON also ensures deep assertions do not compare different VM prototypes.
  return JSON.parse(result) as { words: StaticItem[]; sentences: StaticItem[] };
}

function staticShape(item: (typeof canonicalSentences.items)[number]): StaticItem {
  return {
    word: item.english,
    meaning: item.meaning,
    sound: item.pronunciation,
    category: categoryNames.get(item.categorySlug)!,
    kind: item.kind
  };
}

for (const entrypoint of ["index.html", "typing-practice.html"]) {
  const html = readFileSync(new URL(`../../${entrypoint}`, import.meta.url), "utf8");
  const source = parserSource(html);
  const parsed = parseStandalone(source, wordMarkdown, sentenceMarkdown);

  test(`${entrypoint} actual parsers load 850 words and 270 complete sentences`, () => {
    assert.equal(parsed.words.length, 850);
    assert.equal(parsed.sentences.length, 270);
    assert.deepEqual(parsed.words, canonicalWords.items.map(staticShape));
    assert.deepEqual(parsed.sentences, canonicalSentences.items.map(staticShape));
    for (const item of [...parsed.words, ...parsed.sentences]) {
      assert.ok(item.word.trim(), `${item.category}: English is required`);
      assert.ok(item.meaning.trim(), `${item.word}: meaning is required`);
      assert.ok(item.sound.trim(), `${item.word}: pronunciation is required`);
    }
    for (const [category, count] of [...streetCounts, ...barCounts]) {
      assert.equal(parsed.sentences.filter((item) => item.category === category).length, count, category);
    }
  });

  test(`${entrypoint} includes the same 32 street phrases and pronunciation as the canonical corpus`, () => {
    const additions = canonicalSentences.items.filter((item) => {
      const number = Number(item.key.slice("sentence-".length));
      return number >= 207 && number <= 238;
    });
    assert.equal(additions.length, 32);
    for (const addition of additions) {
      const matching = parsed.sentences.filter((item) => item.word === addition.english &&
        item.category === categoryNames.get(addition.categorySlug));
      assert.deepEqual(matching, [staticShape(addition)], addition.key);
    }
  });

  test(`${entrypoint} includes all 32 new bar phrases and pronunciations in their four public categories`, () => {
    const additions = canonicalSentences.items.filter((item) => Number(item.key.slice("sentence-".length)) >= 239);
    assert.equal(additions.length, 32);
    for (const addition of additions) {
      const matching = parsed.sentences.filter((item) => item.word === addition.english &&
        item.category === categoryNames.get(addition.categorySlug));
      assert.deepEqual(matching, [staticShape(addition)], addition.key);
    }
  });

  test(`${entrypoint} does not expose the Stable ID column as exercise text`, () => {
    const metadataFixture = parseStandalone(source, "", [
      "## 1. Metadata fixture",
      "| English / 中文谐音 | 中文 | Stable ID |",
      "|---|---|---|",
      "| Hello.<br>中文谐音：哈喽 | 你好。 | sentence-9999 |"
    ].join("\n"));
    assert.deepEqual(metadataFixture.sentences, [{
      word: "Hello.", meaning: "你好。", sound: "哈喽", category: "句型：Metadata fixture", kind: "sentence"
    }]);
    for (const item of parsed.sentences) {
      assert.equal(Object.hasOwn(item, "key"), false);
      assert.doesNotMatch(`${item.word}\n${item.meaning}\n${item.sound}`, /Stable ID|sentence-\d{4,}/);
    }
  });

  test(`${entrypoint} bypasses browser caches for both Markdown requests`, () => {
    for (const file of ["basic-english-850.md", "daily-english-high-frequency-sentences.md"]) {
      const escapedFile = file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      assert.match(html, new RegExp(`fetch\\(\\s*["']${escapedFile}["']\\s*,\\s*\\{\\s*cache\\s*:\\s*["']no-store["']\\s*\\}\\s*\\)`));
    }
  });
}

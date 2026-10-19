import type { ParsedContent, ParsedItem } from "./content-parser.js";
import { applyContentUpdate } from "./content-updates.js";
import type { SqliteDatabase } from "./database.js";

export const CET4_WRITING_UPDATE = "content_update:cet4-writing-v1";
const EXPRESSION_GROUPS = [
  { suffix: "opening", title: "开头引入" },
  { suffix: "argument", title: "观点论证" },
  { suffix: "transition", title: "衔接转折" },
  { suffix: "conclusion", title: "总结建议" }
] as const;

function fail(message: string): never {
  throw new Error(`CET4 writing source integrity check failed: ${message}`);
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${field} must be an object`);
  return value as Record<string, unknown>;
}

function text(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim() || value !== value.trim()) fail(`${field} must be nonempty trimmed text`);
  return value;
}

function list(value: unknown, field: string, length?: number): unknown[] {
  if (!Array.isArray(value) || !value.length || (length !== undefined && value.length !== length)) {
    fail(`${field} must contain ${length ?? "one or more"} entries`);
  }
  return value;
}

/** Contractions and hyphenated words count as one; numbers count as words. */
export function countCet4Words(english: string): number {
  return (english.match(/[A-Za-z0-9]+(?:['’\-][A-Za-z0-9]+)*/g) ?? []).length;
}

/** Validate the complete public release before returning any database rows. */
export function parseCet4WritingContent(input: unknown): ParsedContent {
  const source = record(input, "root");
  if (source.version !== 1) fail("version must be 1");
  const essays = list(source.essays, "essays", 10);
  const groups = list(source.expressionGroups, "expressionGroups", 4);
  const parsed: ParsedContent = { categories: [], items: [] };
  const identities = new Set<string>();
  function identity(value: unknown, expected: string, field: string): string {
    const id = text(value, field);
    if (id !== expected) fail(`${field} must be ${expected}`);
    if (identities.has(id)) fail(`duplicate ID ${id}`);
    identities.add(id);
    return id;
  }
  function item(value: unknown, keyPrefix: string, categorySlug: string, sortOrder: number): ParsedItem {
    const sentence = record(value, `${keyPrefix} sentence`);
    const key = text(sentence.key, `${keyPrefix} key`);
    const suffix = key.slice(keyPrefix.length);
    if (!key.startsWith(keyPrefix) || !/^[0-9]{2,}$/.test(suffix) || /^0+$/.test(suffix)) {
      fail(`${key} must use prefix ${keyPrefix} and a nonzero numeric suffix`);
    }
    if (identities.has(key)) fail(`duplicate ID ${key}`);
    identities.add(key);
    return {
      key,
      categorySlug, kind: "sentence", sortOrder, pronunciation: "",
      english: text(sentence.english, `${key}.english`),
      meaning: text(sentence.meaning, `${key}.meaning`)
    };
  }
  for (const [index, value] of essays.entries()) {
    const number = String(index + 1).padStart(2, "0");
    const essay = record(value, `essays[${index}]`);
    const slug = identity(essay.id, `cet4-essay-${number}`, `essays[${index}].id`);
    const title = text(essay.title, `${slug}.title`);
    text(essay.titleEnglish, `${slug}.titleEnglish`);
    text(essay.prompt, `${slug}.prompt`);
    list(essay.outline, `${slug}.outline`).forEach((entry, offset) => text(entry, `${slug}.outline[${offset}]`));
    for (const field of ["greeting", "closing"]) {
      if (essay[field] !== undefined) {
        const part = record(essay[field], `${slug}.${field}`);
        text(part.english, `${slug}.${field}.english`);
        text(part.meaning, `${slug}.${field}.meaning`);
      }
    }
    parsed.categories.push({ slug, name: `四级作文：${title}`, kind: "sentence", sortOrder: 100 + index });
    const sentences: ParsedItem[] = [];
    for (const [paragraphIndex, paragraph] of list(essay.paragraphs, `${slug}.paragraphs`).entries()) {
      for (const entry of list(paragraph, `${slug}.paragraphs[${paragraphIndex}]`)) {
        const order = sentences.length + 1;
        sentences.push(item(entry, `cet4-e${number}-s`, slug, order));
      }
    }
    const wordCount = countCet4Words(sentences.map((sentence) => sentence.english).join(" "));
    if (wordCount < 120 || wordCount > 180) fail(`${slug} body must contain 120–180 words; got ${wordCount}`);
    parsed.items.push(...sentences);
  }
  for (const [index, value] of groups.entries()) {
    const expected = EXPRESSION_GROUPS[index]!;
    const group = record(value, `expressionGroups[${index}]`);
    const slug = identity(group.id, `cet4-phrases-${expected.suffix}`, `expressionGroups[${index}].id`);
    if (text(group.title, `${slug}.title`) !== expected.title) fail(`${slug}.title must be ${expected.title}`);
    parsed.categories.push({ slug, name: `四级句型：${expected.title}`, kind: "sentence", sortOrder: 110 + index });
    for (const [offset, entry] of list(group.items, `${slug}.items`, 10).entries()) {
      parsed.items.push(item(entry, `cet4-${expected.suffix}-`, slug, offset + 1));
    }
  }
  return parsed;
}

/** One-shot additive patch. A completed marker deliberately bypasses source reads. */
export function applyCet4WritingUpdate(db: SqliteDatabase, readSource: () => unknown, bumpVersion: () => string) {
  return db.transaction(() => {
    if (db.prepare("SELECT value FROM app_meta WHERE key = ?").get(CET4_WRITING_UPDATE)) {
      return { categoriesInserted: 0, itemsInserted: 0 };
    }
    const parsed = parseCet4WritingContent(readSource());
    const expectedKeys = new Set(parsed.items.map((item) => item.key));
    // A matching category must not contain unrelated administrator-managed rows.
    for (const category of parsed.categories) {
      const existing = db.prepare(`SELECT items.item_key FROM items
        JOIN categories ON categories.id = items.category_id WHERE categories.slug = ?`).all(category.slug) as Array<{ item_key: string }>;
      if (existing.some((entry) => !expectedKeys.has(entry.item_key))) {
        throw new Error(`CET4 writing update conflict: category ${category.slug} contains unrelated items`);
      }
    }
    return applyContentUpdate(db, {
      marker: CET4_WRITING_UPDATE, select: (content) => content, allowNewCategories: true,
      categoryCount: parsed.categories.length, itemCount: parsed.items.length,
      sourceName: "cet4-writing.json", conflictLabel: "CET4 writing"
    }, () => parsed, bumpVersion);
  }).immediate();
}

import { countCet6Words as countEnglishWords } from "./cet6-writing.js";
import type { ParsedContent, ParsedItem } from "./content-parser.js";
import { applyContentUpdate } from "./content-updates.js";
import type { SqliteDatabase } from "./database.js";

export const GAOKAO_WRITING_SOURCE = "gaokao-writing.json";
export const GAOKAO_WRITING_UPDATE = "content_update:gaokao-writing-v1";

const APPLICATION_COUNT = 6;
const ESSAY_COUNT = 10;

function fail(message: string): never {
  throw new Error(`Gaokao writing source integrity check failed: ${message}`);
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${field} must be an object`);
  return value as Record<string, unknown>;
}

function text(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim() || value.trim() !== value) fail(`${field} must be nonempty trimmed text`);
  return value;
}

function list(value: unknown, field: string, length?: number): unknown[] {
  if (!Array.isArray(value) || !value.length || (length !== undefined && value.length !== length)) {
    fail(`${field} must contain ${length ?? "one or more"} entries`);
  }
  return value;
}

function bilingualText(value: unknown, field: string): { english: string; meaning: string } {
  const part = record(value, field);
  return { english: text(part.english, `${field}.english`), meaning: text(part.meaning, `${field}.meaning`) };
}

function validateWordCount(english: string, field: string, minimum: number, maximum: number): void {
  const count = countEnglishWords(english);
  if (count < minimum || count > maximum) fail(`${field} must contain ${minimum}–${maximum} words; got ${count}`);
}

/** Only the reference essay body contributes practice rows. */
export function parseGaokaoWritingContent(input: unknown): ParsedContent {
  const source = record(input, "root");
  if (source.version !== 1 || source.exam !== "gaokao") fail("expected version 1 and exam gaokao");
  text(source.sourceLabel, "sourceLabel");
  const essays = list(source.essays, "essays", ESSAY_COUNT);
  const parsed: ParsedContent = { categories: [], items: [] };
  const englishTexts = new Set<string>();

  for (const [index, value] of essays.entries()) {
    const number = String(index + 1).padStart(2, "0");
    const slug = `gaokao-essay-${number}`;
    const essay = record(value, slug);
    const continuation = index >= APPLICATION_COUNT;
    const expectedType = continuation ? "continuation" : "application";
    if (essay.id !== slug || essay.type !== expectedType) fail(`expected ${slug} of type ${expectedType}`);
    const title = text(essay.title, `${slug}.title`);
    text(essay.titleEnglish, `${slug}.titleEnglish`);
    text(essay.prompt, `${slug}.prompt`);
    for (const [offset, note] of list(essay.outline, `${slug}.outline`).entries()) {
      text(note, `${slug}.outline[${offset}]`);
    }
    for (const field of ["greeting", "closing"] as const) {
      if (essay[field] !== undefined) bilingualText(essay[field], `${slug}.${field}`);
    }

    const starts = new Set<string>();
    if (continuation) {
      const reading = record(essay.reading, `${slug}.reading`);
      validateWordCount(text(reading.english, `${slug}.reading.english`), `${slug}.reading.english`, 200, 300);
      text(reading.summary, `${slug}.reading.summary`);
      for (const [offset, start] of list(essay.paragraphStarts, `${slug}.paragraphStarts`, 2).entries()) {
        const { english } = bilingualText(start, `${slug}.paragraphStarts[${offset}]`);
        if (starts.has(english)) fail(`${slug} has duplicate paragraph starts`);
        starts.add(english);
      }
    } else if (essay.reading !== undefined || essay.paragraphStarts !== undefined) {
      fail(`${slug} is an application exercise`);
    }

    const items: ParsedItem[] = [];
    const paragraphs = list(essay.paragraphs, `${slug}.paragraphs`, continuation ? 2 : undefined);
    for (const [paragraphIndex, paragraph] of paragraphs.entries()) {
      for (const sentence of list(paragraph, `${slug}.paragraphs[${paragraphIndex}]`, continuation ? 5 : undefined)) {
        const sortOrder = items.length + 1;
        const key = `gaokao-e${number}-s${String(sortOrder).padStart(2, "0")}`;
        const item = record(sentence, key);
        if (item.key !== key) fail(`expected sentence ID ${key}`);
        const { english, meaning } = bilingualText(item, key);
        if (starts.has(english)) fail(`${key} repeats a given paragraph start`);
        if (englishTexts.has(english)) fail(`${key} repeats another exercise sentence`);
        englishTexts.add(english);
        items.push({ key, categorySlug: slug, kind: "sentence", english, meaning, pronunciation: "", sortOrder });
      }
    }
    const sentenceCount = continuation ? 10 : 6;
    if (items.length !== sentenceCount) fail(`${slug} must contain ${sentenceCount} exercise sentences`);
    validateWordCount(items.map((item) => item.english).join(" "), `${slug} body`,
      continuation ? 140 : 75, continuation ? 160 : 95);
    parsed.categories.push({
      slug, name: `${continuation ? "高考读后续写" : "高考应用文"}：${title}`, kind: "sentence", sortOrder: 300 + index
    });
    parsed.items.push(...items);
  }
  return parsed;
}

/** Publish the new exercise rows once without replacing existing study content. */
export function applyGaokaoWritingUpdate(db: SqliteDatabase, readSource: () => unknown, bumpVersion: () => string) {
  return db.transaction(() => {
    if (db.prepare("SELECT value FROM app_meta WHERE key = ?").get(GAOKAO_WRITING_UPDATE)) {
      return { categoriesInserted: 0, itemsInserted: 0 };
    }
    const parsed = parseGaokaoWritingContent(readSource());
    const expectedSlugs = new Map(parsed.items.map((item) => [item.key, item.categorySlug]));
    const findExistingItems = db.prepare(`SELECT items.item_key FROM items
      JOIN categories ON categories.id = items.category_id WHERE categories.slug = ?`);
    for (const { slug } of parsed.categories) {
      const existing = findExistingItems.all(slug) as Array<{ item_key: string }>;
      if (existing.some(({ item_key }) => expectedSlugs.get(item_key) !== slug)) {
        throw new Error(`Gaokao writing update conflict: category ${slug} contains unrelated items`);
      }
    }
    return applyContentUpdate(db, {
      marker: GAOKAO_WRITING_UPDATE, select: (content) => content, allowNewCategories: true,
      categoryCount: parsed.categories.length, itemCount: parsed.items.length,
      sourceName: GAOKAO_WRITING_SOURCE, conflictLabel: "Gaokao writing"
    }, () => parsed, bumpVersion);
  }).immediate();
}

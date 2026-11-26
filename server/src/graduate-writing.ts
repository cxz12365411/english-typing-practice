import { countCet6Words as countEnglishWords } from "./cet6-writing.js";
import type { ParsedContent, ParsedItem } from "./content-parser.js";
import { applyContentUpdate } from "./content-updates.js";
import type { SqliteDatabase } from "./database.js";

export const GRADUATE_WRITING_SOURCE = "graduate-writing.json";
export const GRADUATE_WRITING_UPDATE = "content_update:graduate-writing-v1";

const SECTIONS = [
  { track: "one", type: "short", label: "考研英语一·小作文", words: [90, 115], sentences: 6 },
  { track: "one", type: "long", label: "考研英语一·大作文", words: [160, 200], sentences: 9 },
  { track: "two", type: "short", label: "考研英语二·小作文", words: [90, 115], sentences: 6 },
  { track: "two", type: "long", label: "考研英语二·大作文", words: [140, 165], sentences: 9 }
] as const;
const ESSAYS_PER_SECTION = 2;

function fail(message: string): never {
  throw new Error(`Graduate writing source integrity check failed: ${message}`);
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${field} must be an object`);
  return value as Record<string, unknown>;
}

function text(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim() || value.trim() !== value) fail(`${field} must be nonempty trimmed text`);
  return value;
}

function list(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value) || !value.length) fail(`${field} must be a nonempty array`);
  return value;
}

function textList(value: unknown, field: string): string[] {
  return list(value, field).map((entry, index) => text(entry, `${field}[${index}]`));
}

function bilingualText(value: unknown, field: string): { english: string; meaning: string } {
  const part = record(value, field);
  return { english: text(part.english, `${field}.english`), meaning: text(part.meaning, `${field}.meaning`) };
}

function validateMaterial(essay: Record<string, unknown>, section: typeof SECTIONS[number], slug: string): void {
  const field = `${slug}.material`;
  if (section.type === "short") {
    if (essay.material !== undefined) fail(`${slug} uses an application prompt`);
    return;
  }
  const material = record(essay.material, field);
  if (section.track === "one") {
    if (material.kind !== "picture") fail(`${field} must describe a picture`);
    bilingualText(material, field);
    return;
  }
  if (material.kind !== "table") fail(`${field} must contain a table`);
  text(material.caption, `${field}.caption`);
  const columns = textList(material.columns, `${field}.columns`);
  if (columns.length < 2 || new Set(columns).size !== columns.length) fail(`${field} requires distinct column headings`);
  for (const [index, row] of list(material.rows, `${field}.rows`).entries()) {
    const cells = textList(row, `${field}.rows[${index}]`);
    if (cells.length !== columns.length) fail(`${field}.rows[${index}] must have ${columns.length} cells`);
  }
}

/** Prompts and materials are delivered with the essay, while the body becomes practice items. */
export function parseGraduateWritingContent(input: unknown): ParsedContent {
  const source = record(input, "root");
  if (source.version !== 1 || source.exam !== "graduate") fail("expected version 1 and exam graduate");
  text(source.sourceLabel, "sourceLabel");
  const essays = list(source.essays, "essays");
  if (essays.length !== SECTIONS.length * ESSAYS_PER_SECTION) fail("expected two essays per section");
  const parsed: ParsedContent = { categories: [], items: [] };
  const englishTexts = new Set<string>();

  for (const [index, value] of essays.entries()) {
    const section = SECTIONS[Math.floor(index / ESSAYS_PER_SECTION)]!;
    const number = String(index + 1).padStart(2, "0");
    const slug = `grad-essay-${number}`;
    const essay = record(value, slug);
    if (essay.id !== slug || essay.track !== section.track || essay.type !== section.type) {
      fail(`expected ${slug} for English ${section.track}, ${section.type} writing`);
    }
    const title = text(essay.title, `${slug}.title`);
    text(essay.titleEnglish, `${slug}.titleEnglish`);
    text(essay.prompt, `${slug}.prompt`);
    textList(essay.outline, `${slug}.outline`);
    validateMaterial(essay, section, slug);
    for (const field of ["greeting", "closing"] as const) {
      if (essay[field] !== undefined) bilingualText(essay[field], `${slug}.${field}`);
    }

    const items: ParsedItem[] = [];
    for (const [paragraphIndex, paragraph] of list(essay.paragraphs, `${slug}.paragraphs`).entries()) {
      for (const sentence of list(paragraph, `${slug}.paragraphs[${paragraphIndex}]`)) {
        const sortOrder = items.length + 1;
        const key = `grad-e${number}-s${String(sortOrder).padStart(2, "0")}`;
        const item = record(sentence, key);
        if (item.key !== key) fail(`expected sentence ID ${key}`);
        const { english, meaning } = bilingualText(item, key);
        if (englishTexts.has(english)) fail(`${key} repeats another exercise sentence`);
        englishTexts.add(english);
        items.push({ key, categorySlug: slug, kind: "sentence", english, meaning, pronunciation: "", sortOrder });
      }
    }
    if (items.length !== section.sentences) fail(`${slug} must contain ${section.sentences} practice sentences`);
    const [minWords, maxWords] = section.words;
    const words = countEnglishWords(items.map(({ english }) => english).join(" "));
    if (words < minWords || words > maxWords) fail(`${slug} body must contain ${minWords}–${maxWords} words; got ${words}`);
    parsed.categories.push({ slug, name: `${section.label}：${title}`, kind: "sentence", sortOrder: 320 + index });
    parsed.items.push(...items);
  }
  return parsed;
}

/** Add the graduate essays without replacing existing study content. */
export function applyGraduateWritingUpdate(db: SqliteDatabase, readSource: () => unknown, bumpVersion: () => string) {
  return db.transaction(() => {
    if (db.prepare("SELECT 1 FROM app_meta WHERE key = ?").get(GRADUATE_WRITING_UPDATE)) {
      return { categoriesInserted: 0, itemsInserted: 0 };
    }
    const parsed = parseGraduateWritingContent(readSource());
    const expectedSlugs = new Map(parsed.items.map((item) => [item.key, item.categorySlug]));
    const findExistingItems = db.prepare(`SELECT items.item_key FROM items
      JOIN categories ON categories.id = items.category_id WHERE categories.slug = ?`);
    for (const { slug } of parsed.categories) {
      const existing = findExistingItems.all(slug) as Array<{ item_key: string }>;
      if (existing.some(({ item_key }) => expectedSlugs.get(item_key) !== slug)) {
        throw new Error(`Graduate writing update conflict: category ${slug} contains unrelated items`);
      }
    }
    return applyContentUpdate(db, {
      marker: GRADUATE_WRITING_UPDATE, select: (content) => content, allowNewCategories: true,
      categoryCount: parsed.categories.length, itemCount: parsed.items.length,
      sourceName: GRADUATE_WRITING_SOURCE, conflictLabel: "Graduate writing"
    }, () => parsed, bumpVersion);
  }).immediate();
}

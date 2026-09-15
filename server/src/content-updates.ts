import { randomUUID } from "node:crypto";
import type { ParsedContent } from "./content-parser.js";
import type { SqliteDatabase } from "./database.js";

const STREET_PHOTOGRAPHY_UPDATE = "content_update:street-photography-v1";
const STREET_PHOTOGRAPHY_EXPANSION = "content_update:street-photography-v2";
const STREET_CATEGORIES = [
  { name: "句型：街头摄影：开场与征求同意", size: 4 },
  { name: "句型：街头摄影：拍摄时引导动作", size: 5 },
  { name: "句型：街头摄影：看图和发送照片", size: 3 },
  { name: "句型：街头摄影：礼貌结束", size: 2 }
] as const;
const STREET_ENGLISH = [
  "Hi, excuse me. I'm a street photographer.",
  "I really like your style.",
  "Could I take a photo of you?",
  "It'll only take a minute.",
  "Could you stand here, please?",
  "Turn a little this way, please.",
  "Look over there.",
  "Just relax and be yourself.",
  "Perfect! That looks great.",
  "Would you like to see the photos?",
  "How can I send you the photos?",
  "Is it okay if I post these on Instagram?",
  "Thanks for your time. Have a great day!",
  "No worries. Have a nice day!"
] as const;
const STREET_EXPANSION_ENGLISH = [
  "I'm working on a street photography project.",
  "Your outfit really caught my eye.",
  "I love the colors you're wearing.",
  "Would you like to see some of my work first?",
  "There's no charge for the photos.",
  "No pressure at all. It's completely up to you.",
  "Relax your shoulders.",
  "Look just past the camera.",
  "Could you turn slightly to your left?",
  "You can put your hands in your pockets.",
  "Walk toward me at your normal pace.",
  "Hold that pose for a second.",
  "Which photo do you like best?",
  "Would you like me to take another one?",
  "I can send you the original files.",
  "Could you type your email address here?",
  "Would you like me to tag you when I post them?",
  "I won't post the photos without your permission.",
  "Thank you for being part of my project.",
  "It was lovely meeting you.",
  "You made this shoot really fun.",
  "Of course. I'll delete that photo.",
  "I understand. Thanks anyway.",
  "Feel free to message me if you have any questions."
] as const;

interface ContentUpdateResult {
  categoriesInserted: number;
  itemsInserted: number;
}

function normalizedAnswer(english: string): string {
  return english.normalize("NFKC").replace(/[‘’]/g, "'").trim().replace(/\s+/g, " ").toLocaleLowerCase("en-US");
}

function streetPhotographyContent(parsed: ParsedContent): ParsedContent {
  const categories = parsed.categories.filter((category) =>
    STREET_CATEGORIES.some((_, index) => category.slug === `sentences-${index + 15}`)
  );
  const items = parsed.items.filter((item) =>
    STREET_ENGLISH.some((_, index) => item.key === `sentence-${String(index + 169).padStart(4, "0")}`)
  );
  let offset = 0;
  if (categories.length !== 4 || items.length !== 14) {
    throw new Error("Street photography source integrity check failed: expected 4 categories and 14 items");
  }
  for (let categoryIndex = 0; categoryIndex < STREET_CATEGORIES.length; categoryIndex += 1) {
    const expected = STREET_CATEGORIES[categoryIndex]!;
    const category = categories[categoryIndex]!;
    if (category.slug !== `sentences-${categoryIndex + 15}` || category.name !== expected.name ||
        category.kind !== "sentence" || category.sortOrder !== categoryIndex + 15) {
      throw new Error(`Street photography source integrity check failed for category ${categoryIndex + 15}`);
    }
    for (let itemIndex = 0; itemIndex < expected.size; itemIndex += 1) {
      const item = items[offset]!;
      if (item.key !== `sentence-${String(offset + 169).padStart(4, "0")}` ||
          item.categorySlug !== category.slug || item.kind !== "sentence" ||
          item.english !== STREET_ENGLISH[offset] || item.sortOrder !== itemIndex + 1 ||
          !item.meaning.trim() || !item.pronunciation.trim()) {
        throw new Error(`Street photography source integrity check failed for item ${offset + 169}`);
      }
      offset += 1;
    }
  }
  return { categories, items };
}

function streetPhotographyExpansion(parsed: ParsedContent): ParsedContent {
  const categories = parsed.categories.filter((category) =>
    STREET_CATEGORIES.some((_, index) => category.slug === `sentences-${index + 15}`)
  );
  const items = parsed.items.filter((item) =>
    STREET_EXPANSION_ENGLISH.some((_, index) => item.key === `sentence-${String(index + 183).padStart(4, "0")}`)
  );
  if (categories.length !== 4 || items.length !== 24) {
    throw new Error("Street photography expansion source integrity check failed: expected 4 categories and 24 items");
  }
  for (let categoryIndex = 0; categoryIndex < STREET_CATEGORIES.length; categoryIndex += 1) {
    const expected = STREET_CATEGORIES[categoryIndex]!;
    const category = categories[categoryIndex]!;
    if (category.slug !== `sentences-${categoryIndex + 15}` || category.name !== expected.name ||
        category.kind !== "sentence" || category.sortOrder !== categoryIndex + 15) {
      throw new Error(`Street photography expansion source integrity check failed for category ${categoryIndex + 15}`);
    }
    for (let itemIndex = 0; itemIndex < 6; itemIndex += 1) {
      const offset = categoryIndex * 6 + itemIndex;
      const item = items[offset]!;
      if (item.key !== `sentence-${String(offset + 183).padStart(4, "0")}` ||
          item.categorySlug !== category.slug || item.kind !== "sentence" ||
          item.english !== STREET_EXPANSION_ENGLISH[offset] || item.sortOrder !== expected.size + itemIndex + 1 ||
          !item.meaning.trim() || !item.pronunciation.trim()) {
        throw new Error(`Street photography expansion source integrity check failed for item ${offset + 183}`);
      }
    }
  }
  return { categories, items };
}

interface ContentUpdate {
  marker: string;
  select: (parsed: ParsedContent) => ParsedContent;
  allowNewCategories: boolean;
  itemCount: number;
}

const CONTENT_UPDATES: readonly ContentUpdate[] = [
  { marker: STREET_PHOTOGRAPHY_UPDATE, select: streetPhotographyContent, allowNewCategories: true, itemCount: 14 },
  { marker: STREET_PHOTOGRAPHY_EXPANSION, select: streetPhotographyExpansion, allowNewCategories: false, itemCount: 24 }
];

function applyContentUpdate(
  db: SqliteDatabase,
  update: ContentUpdate,
  readSource: () => ParsedContent,
  bumpVersion: () => string
): ContentUpdateResult {
    const marker = db.prepare("SELECT value FROM app_meta WHERE key = ?").get(update.marker);
    // Do not read source or revisit item states after success: administrators may edit/archive them.
    if (marker) return { categoriesInserted: 0, itemsInserted: 0 };

    const parsed = update.select(readSource());
    const now = Date.now();
    let categoriesInserted = 0;
    let itemsInserted = 0;
    const categoryIds = new Map<string, string>();
    for (const category of parsed.categories) {
      const existing = db.prepare("SELECT * FROM categories WHERE slug = ?").get(category.slug) as
        | { id: string; name: string; kind: string; sort_order: number; status: string; published_at: number | null; archived_at: number | null }
        | undefined;
      if (existing) {
        if (existing.name !== category.name || existing.kind !== category.kind ||
            existing.sort_order !== category.sortOrder || existing.status !== "published" ||
            existing.published_at === null || existing.archived_at !== null) {
          throw new Error(`Street photography update conflict: category ${category.slug} already has different content or state`);
        }
        categoryIds.set(category.slug, existing.id);
        continue;
      }
      if (!update.allowNewCategories) {
        throw new Error(`Street photography update conflict: required category ${category.slug} is missing`);
      }
      const id = randomUUID();
      db.prepare(`
        INSERT INTO categories(id, slug, name, kind, sort_order, status, created_at, updated_at, published_at)
        VALUES (?, ?, ?, ?, ?, 'published', ?, ?, ?)
      `).run(id, category.slug, category.name, category.kind, category.sortOrder, now, now, now);
      categoryIds.set(category.slug, id);
      categoriesInserted += 1;
    }

    for (const item of parsed.items) {
      const categoryId = categoryIds.get(item.categorySlug)!;
      const existing = db.prepare("SELECT * FROM items WHERE item_key = ?").get(item.key) as
        | { id: string; category_id: string; kind: string; english: string; meaning: string; pronunciation: string;
            normalized_answer: string; sort_order: number; revision: number; status: string;
            published_at: number | null; archived_at: number | null }
        | undefined;
      if (existing) {
        if (existing.category_id !== categoryId || existing.kind !== item.kind || existing.english !== item.english ||
            existing.meaning !== item.meaning || existing.pronunciation !== item.pronunciation ||
            existing.normalized_answer !== normalizedAnswer(item.english) || existing.sort_order !== item.sortOrder ||
            existing.revision !== 1 || existing.status !== "published" ||
            existing.published_at === null || existing.archived_at !== null) {
          throw new Error(`Street photography update conflict: item ${item.key} already has different content or state`);
        }
        continue;
      }
      const id = randomUUID();
      db.prepare(`
        INSERT INTO items(id, item_key, category_id, kind, english, meaning, pronunciation, normalized_answer,
          sort_order, revision, status, created_at, updated_at, published_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 'published', ?, ?, ?)
      `).run(id, item.key, categoryId, item.kind, item.english, item.meaning, item.pronunciation,
        normalizedAnswer(item.english), item.sortOrder, now, now, now);
      db.prepare(`
        INSERT INTO item_revisions(item_id, revision, action, snapshot_json, changed_by, created_at)
        VALUES (?, 1, 'content_update', ?, NULL, ?)
      `).run(id, JSON.stringify(item), now);
      itemsInserted += 1;
    }

    if (categoriesInserted || itemsInserted) bumpVersion();
    db.prepare("INSERT INTO app_meta(key, value) VALUES (?, '1')").run(update.marker);
    db.prepare(`
      INSERT INTO audit_log(actor_user_id, action, target_type, target_id, metadata_json, created_at)
      VALUES (NULL, 'content.update', 'content_update', ?, ?, ?)
    `).run(update.marker, JSON.stringify({
      source: "street-photography-english-phrases.md",
      categories: 4,
      items: update.itemCount,
      categoriesInserted,
      itemsInserted
    }), now);
    return { categoriesInserted, itemsInserted };
}

/** Additive, one-shot content patches; never rebuild an existing administrator-managed corpus. */
export function applyContentUpdates(
  db: SqliteDatabase,
  readSource: () => ParsedContent,
  bumpVersion: () => string
): ContentUpdateResult {
  return db.transaction(() => {
    let source: ParsedContent | undefined;
    const readOnce = () => source ??= readSource();
    const result = { categoriesInserted: 0, itemsInserted: 0 };
    for (const update of CONTENT_UPDATES) {
      const applied = applyContentUpdate(db, update, readOnce, bumpVersion);
      result.categoriesInserted += applied.categoriesInserted;
      result.itemsInserted += applied.itemsInserted;
    }
    return result;
  }).immediate();
}

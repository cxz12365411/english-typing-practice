import { randomUUID } from "node:crypto";
import type { ParsedContent } from "./content-parser.js";
import type { SqliteDatabase } from "./database.js";

const STREET_PHOTOGRAPHY_UPDATE = "content_update:street-photography-v1";
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

/** Additive, one-shot content patch; never rebuild an existing administrator-managed corpus. */
export function applyContentUpdates(
  db: SqliteDatabase,
  readSource: () => ParsedContent,
  bumpVersion: () => string
): ContentUpdateResult {
  return db.transaction(() => {
    const marker = db.prepare("SELECT value FROM app_meta WHERE key = ?").get(STREET_PHOTOGRAPHY_UPDATE);
    // Do not read source or revisit item states after success: administrators may edit/archive them.
    if (marker) return { categoriesInserted: 0, itemsInserted: 0 };

    const parsed = streetPhotographyContent(readSource());
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
    db.prepare("INSERT INTO app_meta(key, value) VALUES (?, '1')").run(STREET_PHOTOGRAPHY_UPDATE);
    db.prepare(`
      INSERT INTO audit_log(actor_user_id, action, target_type, target_id, metadata_json, created_at)
      VALUES (NULL, 'content.update', 'content_update', ?, ?, ?)
    `).run(STREET_PHOTOGRAPHY_UPDATE, JSON.stringify({
      source: "street-photography-english-phrases.md",
      categories: 4,
      items: 14,
      categoriesInserted,
      itemsInserted
    }), now);
    return { categoriesInserted, itemsInserted };
  }).immediate();
}

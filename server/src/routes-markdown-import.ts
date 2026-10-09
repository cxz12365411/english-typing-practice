import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { audit, requireAdmin, revalidateAuthenticatedActor } from "./auth.js";
import { bumpContentVersion, type SqliteDatabase } from "./database.js";
import { badRequest, conflict, notFound } from "./errors.js";
import { normalizeAnswer } from "./security.js";
import { enumField, objectBody, stringField } from "./validation.js";
import { normalizeMarkdownCategoryTitle, parseMarkdownImport, type MarkdownImportResult } from "./markdown-import-parser.js";

type Kind = "word" | "sentence";
type Status = "draft" | "published" | "archived";
interface Category {
  id: string; slug: string; name: string; kind: Kind; status: Status;
  sort_order: number; created_at: number; updated_at: number;
}
interface Item {
  id: string; item_key: string; category_id: string; kind: Kind; english: string; meaning: string;
  pronunciation: string; revision: number; status: Status; created_at: number; updated_at: number;
  sort_order: number; normalized_answer: string;
}
interface Mapping { groupId: string; categoryId?: string; name?: string; kind?: Kind }
interface Group {
  groupId: string; row: number; title: string; name: string; kind: Kind;
  action: "existing" | "create" | "ambiguous"; categoryId: string | null;
  candidates?: Array<Pick<Category, "id" | "name" | "kind" | "status">>;
}
interface PreviewRow {
  row: number; groupId: string; categoryName: string; categoryId: string | null; kind: Kind;
  english: string; meaning: string; pronunciation: string;
  action: "create" | "reuse" | "unavailable" | "duplicate"; itemId?: string; message?: string;
}
interface Issue { row: number; field?: string; message: string }
interface Plan {
  groups: Group[]; rows: PreviewRow[]; errors: Issue[]; warnings: Issue[];
  summary: { total: number; created: number; reused: number; unavailable: number; duplicates: number; practiceCount: number; ignoredCount: number };
}
interface StoredPreview {
  version: 1; parsed: MarkdownImportResult; mappings: Mapping[]; fileName: string;
  plan: Plan; snapshot: string;
}
interface CommitResult { ok: true; batchId: string; created: number; reused: number; skipped: number; practiceCount: number }

const PREVIEW_LIFETIME_MS = 30 * 60_000;
const MAX_SORT_ORDER = 1_000_000;

function categoryKey(name: string, kind: Kind): string {
  return `${kind}:${normalizeMarkdownCategoryTitle(name).toLocaleLowerCase("en-US")}`;
}

function readMappings(value: unknown, groupIds: Set<string>): Mapping[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 5_000) badRequest("INVALID_FIELD", "mappings must be an array with at most 5000 entries");
  const seen = new Set<string>();
  return value.map((entry) => {
    const body = objectBody(entry);
    const groupId = stringField(body, "groupId", { min: 1, max: 100 })!;
    if (!groupIds.has(groupId) || seen.has(groupId)) badRequest("INVALID_MAPPING", "Each mapping must identify a unique file group");
    seen.add(groupId);
    const categoryId = stringField(body, "categoryId", { optional: true, min: 1, max: 100 });
    const name = stringField(body, "name", { optional: true, min: 1, max: 100 });
    const kind = enumField(body, "kind", ["word", "sentence"] as const, true);
    return { groupId, ...(categoryId ? { categoryId } : {}), ...(name ? { name } : {}), ...(kind ? { kind } : {}) };
  });
}

// Rebuilt at commit under an IMMEDIATE transaction. Keeping the snapshot separate
// from the public DTO prevents callers from supplying revision or conflict tokens.
function buildPlan(db: SqliteDatabase, parsed: MarkdownImportResult, mappings: Mapping[]): { plan: Plan; snapshot: string } {
  const allCategories = db.prepare("SELECT * FROM categories ORDER BY id").all() as Category[];
  const byId = new Map(allCategories.map((category) => [category.id, category]));
  const byName = new Map<string, Category[]>();
  for (const category of allCategories) {
    const key = categoryKey(category.name, category.kind);
    byName.set(key, [...(byName.get(key) ?? []), category]);
  }
  const byGroup = new Map(mappings.map((mapping) => [mapping.groupId, mapping]));
  const rowGroups = new Map(parsed.rows.map((row) => [row.row, row.groupId]));
  const errors: Issue[] = parsed.errors.filter((issue) => {
    if (issue.field !== "kind") return true;
    const groupId = rowGroups.get(issue.row);
    const mapping = groupId ? byGroup.get(groupId) : undefined;
    // An explicit category/type choice resolves only the parser's mixed-format
    // kind ambiguity. Structural errors and invalid mapping choices remain errors.
    return !(mapping?.kind || mapping?.categoryId);
  });
  const warnings: Issue[] = [...parsed.warnings];
  const snapshot: unknown[] = [];
  const invalidGroups = new Set<string>();
  const groups: Group[] = parsed.groups.map((source) => {
    const mapping = byGroup.get(source.groupId);
    const kind = mapping?.kind ?? source.kind;
    // Parser titles are already normalized exactly once. Use the same display
    // prefix as existing categories so future imports can also strip exactly one.
    const title = mapping?.name === undefined ? source.title : normalizeMarkdownCategoryTitle(mapping.name);
    const name = `${kind === "word" ? "单词" : "句型"}：${title}`;
    const candidates = byName.get(categoryKey(name, kind)) ?? [];
    const category = mapping?.categoryId ? byId.get(mapping.categoryId) : candidates.length === 1 ? candidates[0] : undefined;
    const group: Group = {
      groupId: source.groupId, row: source.row, title: source.title, name, kind,
      action: category ? "existing" : !mapping?.categoryId && candidates.length > 1 ? "ambiguous" : "create",
      categoryId: category?.id ?? null
    };
    const fail = (message: string) => { errors.push({ row: source.row, field: "category", message }); invalidGroups.add(source.groupId); };
    if (!category && (!title || name.length > 100)) fail("分类名称不能为空且连同类型前缀不得超过 100 个字符");
    if (mapping?.categoryId && !category) fail("选择的分类已不存在，请重新选择");
    if (category) {
      group.name = category.name;
      group.kind = category.kind;
      if (mapping?.kind && mapping.kind !== category.kind) fail("所选类型与目标分类不一致");
      if (category.status !== "published") fail("目标分类尚未发布或已经下架，请在题库管理中处理后重新预览");
      snapshot.push({ groupId: source.groupId, category });
    } else {
      snapshot.push({ groupId: source.groupId, candidates });
    }
    if (group.action === "ambiguous") {
      group.candidates = candidates.map(({ id, name: candidateName, kind: candidateKind, status }) => ({ id, name: candidateName, kind: candidateKind, status }));
      fail("存在多个同名同类型分类，请手动选择目标分类");
    }
    return group;
  });
  const groupMap = new Map(groups.map((group) => [group.groupId, group]));
  const seen = new Set<string>();
  const rows: PreviewRow[] = [];
  const findItems = db.prepare(`SELECT * FROM items WHERE category_id = ? AND kind = ? AND normalized_answer = ?
    ORDER BY CASE WHEN status = 'published' THEN 0 ELSE 1 END, created_at, id`);
  const newCounts = new Map<string, number>();
  for (const source of parsed.rows) {
    const group = groupMap.get(source.groupId)!;
    const target = group.categoryId ?? categoryKey(group.name, group.kind);
    const answer = normalizeAnswer(source.english);
    const key = JSON.stringify([target, group.kind, answer]);
    const row: PreviewRow = {
      row: source.row, groupId: source.groupId, categoryName: group.name, categoryId: group.categoryId, kind: group.kind,
      english: source.english, meaning: source.meaning, pronunciation: source.pronunciation, action: "create"
    };
    if (invalidGroups.has(source.groupId)) {
      row.action = "unavailable";
      row.message = "分类设置存在错误";
    } else if (!answer || source.english.length > 500 || !source.meaning || source.meaning.length > 1000 || source.pronunciation.length > 500) {
      errors.push({ row: source.row, message: "英文和中文释义必填，英文/谐音最多 500 字符，释义最多 1000 字符" });
      row.action = "unavailable";
      row.message = "字段格式错误";
    } else if (seen.has(key)) {
      row.action = "duplicate";
      row.message = "文件内重复，保留首次出现的题目";
    } else {
      seen.add(key);
      const matches = group.categoryId ? findItems.all(group.categoryId, group.kind, answer) as Item[] : [];
      snapshot.push({ key, matches });
      const existing = matches[0];
      if (existing) {
        row.itemId = existing.id;
        row.english = existing.english;
        row.meaning = existing.meaning;
        row.pronunciation = existing.pronunciation;
        row.action = existing.status === "published" ? "reuse" : "unavailable";
        row.message = existing.status === "published" ? "复用已有题，保留原释义与谐音" : "已有题目为草稿或已下架，跳过且不恢复发布";
      } else {
        newCounts.set(target, (newCounts.get(target) ?? 0) + 1);
      }
    }
    rows.push(row);
  }
  const newCategoryKeys = new Set<string>();
  for (const group of groups) {
    const key = group.categoryId ?? categoryKey(group.name, group.kind);
    if (!newCounts.has(key)) continue;
    if (!group.categoryId) { newCategoryKeys.add(key); continue; }
    const max = (db.prepare("SELECT COALESCE(MAX(sort_order), 0) AS value FROM items WHERE category_id = ?").get(group.categoryId) as { value: number }).value;
    if (max + newCounts.get(key)! > MAX_SORT_ORDER) errors.push({ row: group.row, field: "sortOrder", message: "目标分类题目排序已达到上限" });
  }
  const categoryMax = (db.prepare("SELECT COALESCE(MAX(sort_order), 0) AS value FROM categories").get() as { value: number }).value;
  if (categoryMax + newCategoryKeys.size > MAX_SORT_ORDER) errors.push({ row: 0, field: "sortOrder", message: "分类排序已达到上限" });
  const count = (action: PreviewRow["action"]) => rows.filter((row) => row.action === action).length;
  const created = count("create");
  const reused = count("reuse");
  return {
    plan: { groups, rows, errors, warnings, summary: { total: rows.length, created, reused, unavailable: count("unavailable"), duplicates: count("duplicate"), practiceCount: created + reused, ignoredCount: parsed.ignoredCount } },
    snapshot: JSON.stringify(snapshot)
  };
}

export async function registerMarkdownImportRoutes(app: FastifyInstance, db: SqliteDatabase): Promise<void> {
  app.post("/api/admin/markdown-imports/preview", {
    bodyLimit: 2_100_000,
    onRequest: async (request) => { requireAdmin(request); }
  }, async (request) => {
    const admin = requireAdmin(request);
    const body = objectBody(request.body);
    const markdown = stringField(body, "markdown", { min: 1, max: 1_048_576, trim: false })!;
    if (Buffer.byteLength(markdown, "utf8") > 1_048_576) badRequest("MARKDOWN_TOO_LARGE", "Markdown 文件不得超过 1 MiB");
    const fileName = stringField(body, "fileName", { optional: true, min: 1, max: 255 });
    const defaultCategoryName = stringField(body, "defaultCategoryName", { optional: true, min: 1, max: 100 });
    const parsed = parseMarkdownImport(markdown, {
      ...(fileName ? { fileName } : {}), ...(defaultCategoryName ? { defaultCategoryName } : {})
    });
    const mappings = readMappings(body.mappings, new Set(parsed.groups.map((group) => group.groupId)));
    const { plan, snapshot } = buildPlan(db, parsed, mappings);
    const previewId = randomUUID();
    const now = Date.now();
    const expiresAt = now + PREVIEW_LIFETIME_MS;
    const stored: StoredPreview = { version: 1, parsed, mappings, fileName: fileName ?? "粘贴的 Markdown", plan, snapshot };
    db.transaction(() => {
      revalidateAuthenticatedActor(db, request, admin, "admin");
      db.prepare(`INSERT INTO import_previews(id, created_by, payload_json, errors_json, row_count, created_at, expires_at, format)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'markdown')`).run(previewId, admin.id, JSON.stringify(stored), JSON.stringify(plan.errors), plan.rows.length, now, expiresAt);
      audit(db, request, "admin.markdown_import_previewed", "import_preview", previewId, { rows: plan.rows.length, errors: plan.errors.length });
    }).immediate();
    return { previewId, ...plan, expiresAt: new Date(expiresAt).toISOString() };
  });

  app.post("/api/admin/markdown-imports/commit", { onRequest: async (request) => { requireAdmin(request); } }, async (request) => {
    const admin = requireAdmin(request);
    const previewId = stringField(objectBody(request.body), "previewId", { min: 1, max: 100 })!;
    return db.transaction((): CommitResult => {
      revalidateAuthenticatedActor(db, request, admin, "admin");
      const previous = db.prepare("SELECT result_json FROM import_batches WHERE source_preview_id = ? AND created_by = ?").get(previewId, admin.id) as { result_json: string } | undefined;
      if (previous) return JSON.parse(previous.result_json) as CommitResult;
      const preview = db.prepare("SELECT * FROM import_previews WHERE id = ? AND created_by = ?").get(previewId, admin.id) as {
        format: string; payload_json: string; errors_json: string; expires_at: number; committed_at: number | null;
      } | undefined;
      if (!preview) notFound("Import preview not found");
      if (preview.format !== "markdown") conflict("IMPORT_FORMAT_MISMATCH", "This is not a Markdown preview");
      if (preview.committed_at) conflict("IMPORT_ALREADY_COMMITTED", "Import preview has already been committed");
      const now = Date.now();
      if (preview.expires_at <= now) conflict("IMPORT_EXPIRED", "预览已过期，请重新预览");
      const stored = JSON.parse(preview.payload_json) as StoredPreview;
      if (stored.version !== 1) conflict("IMPORT_PREVIEW_OUTDATED", "请重新生成预览");
      if (stored.plan.errors.length) badRequest("IMPORT_HAS_ERRORS", "请先修复预览中的全部错误", { errors: stored.plan.errors });
      const current = buildPlan(db, stored.parsed, stored.mappings);
      if (current.snapshot !== stored.snapshot || JSON.stringify(current.plan) !== JSON.stringify(stored.plan)) {
        conflict("IMPORT_CONTENT_CHANGED", "题库或分类在预览后发生变化，请重新预览");
      }
      const plan = current.plan;
      if (!plan.summary.practiceCount) badRequest("IMPORT_NOT_PRACTICEABLE", "这份文件没有可练习的题目，不会创建空分类或批次");
      const groupMap = new Map(plan.groups.map((group) => [group.groupId, group]));
      const newCategories = new Map<string, string>();
      let categoryOrder = (db.prepare("SELECT COALESCE(MAX(sort_order), 0) AS value FROM categories").get() as { value: number }).value;
      const itemOrders = new Map<string, number>();
      const batchItemIds: string[] = [];
      for (const row of plan.rows) {
        if (row.action === "reuse") { batchItemIds.push(row.itemId!); continue; }
        if (row.action !== "create") continue;
        const group = groupMap.get(row.groupId)!;
        let categoryId = group.categoryId;
        if (!categoryId) {
          const key = categoryKey(group.name, group.kind);
          categoryId = newCategories.get(key) ?? null;
          if (!categoryId) {
            categoryId = randomUUID();
            db.prepare(`INSERT INTO categories(id, slug, name, kind, sort_order, status, created_at, updated_at, published_at)
              VALUES (?, ?, ?, ?, ?, 'published', ?, ?, ?)`).run(categoryId, `md-${randomUUID()}`, group.name, group.kind, ++categoryOrder, now, now, now);
            newCategories.set(key, categoryId);
          }
        }
        const previousOrder = itemOrders.get(categoryId) ?? (db.prepare("SELECT COALESCE(MAX(sort_order), 0) AS value FROM items WHERE category_id = ?").get(categoryId) as { value: number }).value;
        const sortOrder = previousOrder + 1;
        itemOrders.set(categoryId, sortOrder);
        const id = randomUUID();
        const key = `md-${randomUUID()}`;
        db.prepare(`INSERT INTO items(id, item_key, category_id, kind, english, meaning, pronunciation, normalized_answer,
          sort_order, revision, status, created_at, updated_at, published_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 'published', ?, ?, ?)`).run(
          id, key, categoryId, row.kind, row.english, row.meaning, row.pronunciation, normalizeAnswer(row.english), sortOrder, now, now, now
        );
        const itemSnapshot = { id, key, categoryId, kind: row.kind, english: row.english, meaning: row.meaning,
          pronunciation: row.pronunciation, sortOrder, revision: 1, status: "published", createdAt: new Date(now).toISOString(),
          updatedAt: new Date(now).toISOString(), publishedAt: new Date(now).toISOString() };
        db.prepare(`INSERT INTO item_revisions(item_id, revision, action, snapshot_json, changed_by, created_at)
          VALUES (?, 1, 'markdown_create', ?, ?, ?)`).run(id, JSON.stringify(itemSnapshot), admin.id, now);
        batchItemIds.push(id);
      }
      const batchId = randomUUID();
      const result: CommitResult = { ok: true, batchId, created: plan.summary.created, reused: plan.summary.reused,
        skipped: plan.summary.unavailable + plan.summary.duplicates, practiceCount: batchItemIds.length };
      db.prepare(`INSERT INTO import_batches(id, created_by, source_preview_id, file_name, result_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?)`).run(batchId, admin.id, previewId, stored.fileName, JSON.stringify(result), now);
      const addMember = db.prepare("INSERT INTO import_batch_items(batch_id, item_id, sort_order) VALUES (?, ?, ?)");
      batchItemIds.forEach((id, index) => addMember.run(batchId, id, index));
      // Parsed upload contents are needed only for validation. Keep the independent
      // batch, ordered membership and result, but erase the temporary payload now.
      db.prepare("UPDATE import_previews SET committed_at = ?, payload_json = '{}' WHERE id = ?").run(now, previewId);
      if (result.created) bumpContentVersion(db);
      audit(db, request, "admin.markdown_import_committed", "import_batch", batchId, { previewId, ...result });
      return result;
    }).immediate();
  });
}

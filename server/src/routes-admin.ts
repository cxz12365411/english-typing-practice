import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { parse as parseCsv } from "csv-parse/sync";
import type { SqliteDatabase } from "./database.js";
import { bumpContentVersion } from "./database.js";
import {
  audit,
  clearLoginGuards,
  requireAdmin,
  revalidateAuthenticatedActor,
  revokeUserSessions,
  toUserDto,
  type UserRow
} from "./auth.js";
import { badRequest, conflict, notFound } from "./errors.js";
import { hashPassword, normalizeAnswer, temporaryPassword, validateUsername } from "./security.js";
import { booleanField, enumField, idParam, integerField, objectBody, stringField } from "./validation.js";

type Kind = "word" | "sentence";
type PublishStatus = "draft" | "published" | "archived";

interface CategoryRow {
  id: string;
  slug: string;
  name: string;
  kind: Kind;
  sort_order: number;
  status: PublishStatus;
  created_at: number;
  updated_at: number;
  published_at: number | null;
  archived_at: number | null;
}

interface ItemRow {
  id: string;
  item_key: string;
  category_id: string;
  kind: Kind;
  english: string;
  meaning: string;
  pronunciation: string;
  normalized_answer: string;
  sort_order: number;
  revision: number;
  status: PublishStatus;
  created_at: number;
  updated_at: number;
  published_at: number | null;
  archived_at: number | null;
}

function categoryDto(row: CategoryRow) {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    kind: row.kind,
    sortOrder: row.sort_order,
    status: row.status,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
    ...(row.published_at ? { publishedAt: new Date(row.published_at).toISOString() } : {}),
    ...(row.archived_at ? { archivedAt: new Date(row.archived_at).toISOString() } : {})
  };
}

function itemDto(row: ItemRow) {
  return {
    id: row.id,
    key: row.item_key,
    categoryId: row.category_id,
    kind: row.kind,
    english: row.english,
    meaning: row.meaning,
    pronunciation: row.pronunciation,
    sortOrder: row.sort_order,
    revision: row.revision,
    status: row.status,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
    ...(row.published_at ? { publishedAt: new Date(row.published_at).toISOString() } : {}),
    ...(row.archived_at ? { archivedAt: new Date(row.archived_at).toISOString() } : {})
  };
}

function getCategory(db: SqliteDatabase, id: string): CategoryRow {
  const row = db.prepare("SELECT * FROM categories WHERE id = ?").get(id) as CategoryRow | undefined;
  if (!row) notFound("Category not found");
  return row;
}

function getItem(db: SqliteDatabase, id: string): ItemRow {
  const row = db.prepare("SELECT * FROM items WHERE id = ?").get(id) as ItemRow | undefined;
  if (!row) notFound("Item not found");
  return row;
}

function itemSnapshot(row: ItemRow): string {
  return JSON.stringify(itemDto(row));
}

function addRevision(db: SqliteDatabase, row: ItemRow, action: string, actorId: string): void {
  db.prepare(`
    INSERT INTO item_revisions(item_id, revision, action, snapshot_json, changed_by, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(row.id, row.revision, action, itemSnapshot(row), actorId, Date.now());
}

function activeAdminCount(db: SqliteDatabase): number {
  return (db.prepare("SELECT COUNT(*) AS count FROM users WHERE role = 'admin' AND active = 1").get() as { count: number }).count;
}

function safeSlug(value: string): string {
  const slug = value.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]{1,63}$/.test(slug)) {
    badRequest("INVALID_SLUG", "slug must contain 2-64 lowercase letters, digits, dots, underscores or hyphens", { field: "slug" });
  }
  return slug;
}

function ensureUniqueCategorySlug(db: SqliteDatabase, slug: string, exceptId?: string): void {
  const row = db.prepare("SELECT id FROM categories WHERE slug = ? AND id <> ?").get(slug, exceptId ?? "") as { id: string } | undefined;
  if (row) conflict("CATEGORY_SLUG_EXISTS", "A category with this slug already exists");
}

function ensureUniqueItemKey(db: SqliteDatabase, key: string, exceptId?: string): void {
  const row = db.prepare("SELECT id FROM items WHERE item_key = ? AND id <> ?").get(key, exceptId ?? "") as { id: string } | undefined;
  if (row) conflict("ITEM_KEY_EXISTS", "An item with this key already exists");
}

interface CsvPreviewRow {
  row: number;
  key: string;
  categoryId: string;
  kind: Kind;
  english: string;
  meaning: string;
  pronunciation: string;
  sortOrder: number;
  status: "draft" | "published";
}

interface CsvError {
  row: number;
  field?: string;
  message: string;
}

function parseImport(db: SqliteDatabase, csv: string, fallbackCategoryId?: string): { rows: CsvPreviewRow[]; errors: CsvError[] } {
  let records: Array<Record<string, string>>;
  try {
    records = parseCsv(csv, { columns: true, bom: true, skip_empty_lines: true, trim: true, relax_column_count: false });
  } catch (error) {
    return { rows: [], errors: [{ row: 0, message: (error as Error).message }] };
  }
  if (records.length > 5_000) return { rows: [], errors: [{ row: 0, message: "CSV may contain at most 5000 rows" }] };
  const rows: CsvPreviewRow[] = [];
  const errors: CsvError[] = [];
  const seenKeys = new Set<string>();
  for (let index = 0; index < records.length; index += 1) {
    const input = records[index]!;
    const rowNumber = index + 2;
    const categoryId = (input.categoryId || fallbackCategoryId || "").trim();
    const category = categoryId
      ? (db.prepare("SELECT * FROM categories WHERE id = ?").get(categoryId) as CategoryRow | undefined)
      : undefined;
    const kind = (input.kind || category?.kind || "") as Kind;
    const english = (input.english || "").trim();
    const meaning = (input.meaning || "").trim();
    const pronunciation = (input.pronunciation || "").trim();
    const key = (input.key || `import-${randomUUID()}`).trim();
    const sortOrderValue = input.sortOrder ? Number(input.sortOrder) : index + 1;
    const status = (input.status || "draft") as "draft" | "published";
    if (!category) errors.push({ row: rowNumber, field: "categoryId", message: "Category not found" });
    if (kind !== "word" && kind !== "sentence") errors.push({ row: rowNumber, field: "kind", message: "kind must be word or sentence" });
    if (category && category.kind !== kind) errors.push({ row: rowNumber, field: "kind", message: "kind does not match category" });
    if (!english || english.length > 500) errors.push({ row: rowNumber, field: "english", message: "english is required (max 500)" });
    if (!meaning || meaning.length > 1000) errors.push({ row: rowNumber, field: "meaning", message: "meaning is required (max 1000)" });
    if (pronunciation.length > 500) errors.push({ row: rowNumber, field: "pronunciation", message: "pronunciation exceeds 500 characters" });
    if (!key || key.length > 100) errors.push({ row: rowNumber, field: "key", message: "key is required (max 100)" });
    if (seenKeys.has(key)) errors.push({ row: rowNumber, field: "key", message: "duplicate key in CSV" });
    seenKeys.add(key);
    if (!Number.isInteger(sortOrderValue) || sortOrderValue < 0 || sortOrderValue > 1_000_000) {
      errors.push({ row: rowNumber, field: "sortOrder", message: "sortOrder must be an integer from 0 to 1000000" });
    }
    if (status !== "draft" && status !== "published") errors.push({ row: rowNumber, field: "status", message: "status must be draft or published" });
    if (category && (kind === "word" || kind === "sentence") && english && meaning && key && Number.isInteger(sortOrderValue)) {
      rows.push({ row: rowNumber, key, categoryId, kind, english, meaning, pronunciation, sortOrder: sortOrderValue, status });
    }
  }
  return { rows, errors };
}

export async function registerAdminRoutes(app: FastifyInstance, db: SqliteDatabase): Promise<void> {
  app.get("/api/admin/users", async (request) => {
    requireAdmin(request);
    const users = db.prepare("SELECT * FROM users ORDER BY created_at DESC, username").all() as UserRow[];
    return { users: users.map(toUserDto) };
  });

  app.post("/api/admin/users", async (request) => {
    const admin = requireAdmin(request);
    const body = objectBody(request.body);
    let username: string;
    try {
      username = validateUsername(stringField(body, "username", { min: 3, max: 32 })!);
    } catch (error) {
      badRequest("INVALID_USERNAME", (error as Error).message, { field: "username" });
    }
    if (db.prepare("SELECT 1 FROM users WHERE username = ? COLLATE NOCASE").get(username!)) {
      conflict("USERNAME_EXISTS", "Username already exists");
    }
    const displayName = stringField(body, "displayName", { optional: true, min: 1, max: 80 }) ?? username!;
    const role = enumField(body, "role", ["user", "admin"] as const, true) ?? "user";
    const generatedPassword = temporaryPassword();
    const passwordHash = await hashPassword(generatedPassword);
    const id = randomUUID();
    const now = Date.now();
    db.transaction(() => {
      revalidateAuthenticatedActor(db, request, admin, "admin");
      if (db.prepare("SELECT 1 FROM users WHERE username = ? COLLATE NOCASE").get(username!)) {
        conflict("USERNAME_EXISTS", "Username already exists");
      }
      db.prepare(`
        INSERT INTO users(
          id, username, display_name, password_hash, role, active, must_change_password, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 1, 1, ?, ?)
      `).run(id, username!, displayName, passwordHash, role, now, now);
      audit(db, request, "admin.user_created", "user", id, { username: username!, role });
    }).immediate();
    const created = db.prepare("SELECT * FROM users WHERE id = ?").get(id) as UserRow;
    return { user: toUserDto(created), temporaryPassword: generatedPassword };
  });

  app.patch("/api/admin/users/:id", async (request) => {
    const admin = requireAdmin(request);
    const targetId = idParam(request.params);
    const target = db.prepare("SELECT * FROM users WHERE id = ?").get(targetId) as UserRow | undefined;
    if (!target) notFound("User not found");
    const body = objectBody(request.body);
    const displayName = stringField(body, "displayName", { optional: true, min: 1, max: 80 });
    const role = enumField(body, "role", ["user", "admin"] as const, true);
    const active = booleanField(body, "active");
    if (displayName === undefined && role === undefined && active === undefined) {
      badRequest("NO_CHANGES", "At least one mutable field is required");
    }
    const now = Date.now();
    const updatedUser = db.transaction(() => {
      revalidateAuthenticatedActor(db, request, admin, "admin");
      const current = db.prepare("SELECT * FROM users WHERE id = ?").get(targetId) as UserRow | undefined;
      if (!current) notFound("User not found");
      const nextRole = role ?? current.role;
      const nextActive = active === undefined ? Boolean(current.active) : active;
      if (current.role === "admin" && current.active && (nextRole !== "admin" || !nextActive) && activeAdminCount(db) <= 1) {
        conflict("LAST_ADMIN", "The last active administrator cannot be disabled or demoted");
      }
      const changedSecurity = nextRole !== current.role || nextActive !== Boolean(current.active);
      db.prepare(`
        UPDATE users SET display_name = ?, role = ?, active = ?,
          auth_version = auth_version + ?, updated_at = ? WHERE id = ?
      `).run(displayName ?? current.display_name, nextRole, nextActive ? 1 : 0, changedSecurity ? 1 : 0, now, targetId);
      if (changedSecurity) revokeUserSessions(db, targetId);
      audit(db, request, "admin.user_updated", "user", targetId, {
        displayName: displayName ?? current.display_name,
        role: nextRole,
        status: nextActive ? "active" : "disabled"
      });
      return db.prepare("SELECT * FROM users WHERE id = ?").get(targetId) as UserRow;
    }).immediate();
    return { user: toUserDto(updatedUser) };
  });

  app.delete("/api/admin/users/:id", async (request) => {
    const admin = requireAdmin(request);
    const targetId = idParam(request.params);
    const now = Date.now();
    const updatedUser = db.transaction(() => {
      revalidateAuthenticatedActor(db, request, admin, "admin");
      const target = db.prepare("SELECT * FROM users WHERE id = ?").get(targetId) as UserRow | undefined;
      if (!target) notFound("User not found");
      if (target.role === "admin" && target.active && activeAdminCount(db) <= 1) {
        conflict("LAST_ADMIN", "The last active administrator cannot be disabled");
      }
      db.prepare("UPDATE users SET active = 0, auth_version = auth_version + 1, updated_at = ? WHERE id = ?").run(now, targetId);
      revokeUserSessions(db, targetId);
      audit(db, request, "admin.user_disabled", "user", targetId);
      return db.prepare("SELECT * FROM users WHERE id = ?").get(targetId) as UserRow;
    }).immediate();
    return { user: toUserDto(updatedUser) };
  });

  app.post("/api/admin/users/:id/reset-password", async (request) => {
    const admin = requireAdmin(request);
    const targetId = idParam(request.params);
    if (targetId === admin.id) {
      conflict("SELF_PASSWORD_RESET_FORBIDDEN", "Use the account password form to change your own password");
    }
    const target = db.prepare("SELECT * FROM users WHERE id = ?").get(targetId) as UserRow | undefined;
    if (!target) notFound("User not found");
    const generatedPassword = temporaryPassword();
    const passwordHash = await hashPassword(generatedPassword);
    const now = Date.now();
    db.transaction(() => {
      revalidateAuthenticatedActor(db, request, admin, "admin");
      const currentTarget = db.prepare("SELECT * FROM users WHERE id = ?").get(targetId) as UserRow | undefined;
      if (
        !currentTarget ||
        currentTarget.auth_version !== target!.auth_version ||
        currentTarget.password_hash !== target!.password_hash
      ) conflict("TARGET_STATE_CHANGED", "The target account changed while the reset was being prepared");
      const updated = db.prepare(`
        UPDATE users
        SET password_hash = ?, must_change_password = 1,
            email = NULL, email_verified_at = NULL,
            auth_version = auth_version + 1, updated_at = ?
        WHERE id = ? AND auth_version = ? AND password_hash = ?
      `).run(passwordHash, now, targetId, target!.auth_version, target!.password_hash);
      if (updated.changes !== 1) conflict("TARGET_STATE_CHANGED", "The target account changed while the reset was being prepared");
      revokeUserSessions(db, targetId);
      clearLoginGuards(db, target!.username);
      audit(db, request, "admin.password_reset", "user", targetId, { emailCleared: Boolean(currentTarget.email) });
    }).immediate();
    return { user: toUserDto(db.prepare("SELECT * FROM users WHERE id = ?").get(targetId) as UserRow), temporaryPassword: generatedPassword };
  });

  app.post("/api/admin/users/:id/revoke-sessions", async (request) => {
    requireAdmin(request);
    const targetId = idParam(request.params);
    if (!db.prepare("SELECT 1 FROM users WHERE id = ?").get(targetId)) notFound("User not found");
    const revoked = revokeUserSessions(db, targetId);
    audit(db, request, "admin.sessions_revoked", "user", targetId, { revoked });
    return { ok: true, revoked };
  });

  app.get("/api/admin/stats", async (request) => {
    requireAdmin(request);
    const users = db.prepare(`
      SELECT COUNT(*) AS total,
             SUM(CASE WHEN active = 1 THEN 1 ELSE 0 END) AS active,
             SUM(CASE WHEN role = 'admin' AND active = 1 THEN 1 ELSE 0 END) AS admins
      FROM users
    `).get() as { total: number; active: number; admins: number };
    const content = db.prepare(`
      SELECT COUNT(*) AS total,
             SUM(CASE WHEN kind = 'word' AND status = 'published' THEN 1 ELSE 0 END) AS words,
             SUM(CASE WHEN kind = 'sentence' AND status = 'published' THEN 1 ELSE 0 END) AS sentences,
             SUM(CASE WHEN status = 'draft' THEN 1 ELSE 0 END) AS drafts,
             SUM(CASE WHEN status = 'archived' THEN 1 ELSE 0 END) AS archived
      FROM items
    `).get() as { total: number; words: number; sentences: number; drafts: number; archived: number };
    const practice = db.prepare(`
      SELECT COUNT(*) AS sessions, COALESCE(SUM(total_attempts), 0) AS attempts,
             COALESCE(SUM(correct_attempts), 0) AS correct, COALESCE(SUM(duration_ms), 0) AS duration_ms
      FROM practice_sessions
    `).get() as { sessions: number; attempts: number; correct: number; duration_ms: number };
    return {
      users,
      content,
      practice: {
        sessions: practice.sessions,
        attempts: practice.attempts,
        correct: practice.correct,
        accuracy: practice.attempts ? practice.correct / practice.attempts : 0,
        durationMs: practice.duration_ms
      }
    };
  });

  app.get("/api/admin/categories", async (request) => {
    requireAdmin(request);
    const rows = db.prepare("SELECT * FROM categories ORDER BY kind, sort_order, id").all() as CategoryRow[];
    return { categories: rows.map(categoryDto) };
  });

  app.post("/api/admin/categories", async (request) => {
    const admin = requireAdmin(request);
    const body = objectBody(request.body);
    const slug = safeSlug(stringField(body, "slug", { min: 2, max: 64 })!);
    ensureUniqueCategorySlug(db, slug);
    const name = stringField(body, "name", { min: 1, max: 100 })!;
    const kind = enumField(body, "kind", ["word", "sentence"] as const)!;
    const sortOrder = integerField(body, "sortOrder", { min: 0, max: 1_000_000, optional: true }) ?? 0;
    const id = randomUUID();
    const now = Date.now();
    db.transaction(() => {
      db.prepare(`
        INSERT INTO categories(id, slug, name, kind, sort_order, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 'draft', ?, ?)
      `).run(id, slug, name, kind, sortOrder, now, now);
      audit(db, request, "admin.category_created", "category", id, { slug, kind });
    })();
    return { category: categoryDto(getCategory(db, id)) };
  });

  app.patch("/api/admin/categories/:id", async (request) => {
    const admin = requireAdmin(request);
    const id = idParam(request.params);
    const category = getCategory(db, id);
    const body = objectBody(request.body);
    const slugValue = stringField(body, "slug", { optional: true, min: 2, max: 64 });
    const slug = slugValue ? safeSlug(slugValue) : category.slug;
    ensureUniqueCategorySlug(db, slug, id);
    const name = stringField(body, "name", { optional: true, min: 1, max: 100 }) ?? category.name;
    const sortOrder = integerField(body, "sortOrder", { optional: true, min: 0, max: 1_000_000 }) ?? category.sort_order;
    const kind = enumField(body, "kind", ["word", "sentence"] as const, true) ?? category.kind;
    if (kind !== category.kind && db.prepare("SELECT 1 FROM items WHERE category_id = ? LIMIT 1").get(id)) {
      conflict("CATEGORY_NOT_EMPTY", "Cannot change the kind of a category that contains items");
    }
    const now = Date.now();
    db.transaction(() => {
      const nextStatus = category.status === "published" ? "draft" : category.status;
      db.prepare("UPDATE categories SET slug = ?, name = ?, kind = ?, sort_order = ?, status = ?, updated_at = ? WHERE id = ?").run(
        slug,
        name,
        kind,
        sortOrder,
        nextStatus,
        now,
        id
      );
      if (category.status === "published") bumpContentVersion(db);
      audit(db, request, "admin.category_updated", "category", id);
    })();
    return { category: categoryDto(getCategory(db, id)) };
  });

  const setCategoryStatus = (status: "published" | "archived") => async (request: FastifyRequest) => {
    requireAdmin(request);
    const id = idParam(request.params);
    const category = getCategory(db, id);
    const now = Date.now();
    db.transaction(() => {
      db.prepare(`
        UPDATE categories SET status = ?, updated_at = ?,
          published_at = CASE WHEN ? = 'published' THEN COALESCE(published_at, ?) ELSE published_at END,
          archived_at = CASE WHEN ? = 'archived' THEN ? ELSE NULL END
        WHERE id = ?
      `).run(status, now, status, now, status, now, id);
      bumpContentVersion(db);
      audit(db, request, `admin.category_${status}`, "category", id, { previousStatus: category.status });
    })();
    return { category: categoryDto(getCategory(db, id)) };
  };
  app.post("/api/admin/categories/:id/publish", setCategoryStatus("published"));
  app.post("/api/admin/categories/:id/archive", setCategoryStatus("archived"));
  app.delete("/api/admin/categories/:id", setCategoryStatus("archived"));

  app.get("/api/admin/items", async (request) => {
    requireAdmin(request);
    const query = (request.query ?? {}) as Record<string, unknown>;
    const status = typeof query.status === "string" ? query.status : undefined;
    const categoryId = typeof query.categoryId === "string" ? query.categoryId : undefined;
    if (status && !["draft", "published", "archived"].includes(status)) badRequest("INVALID_QUERY", "Invalid status query");
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (status) { clauses.push("status = ?"); params.push(status); }
    if (categoryId) { clauses.push("category_id = ?"); params.push(categoryId); }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = db.prepare(`SELECT * FROM items ${where} ORDER BY kind, category_id, sort_order, id`).all(...params) as ItemRow[];
    return { items: rows.map(itemDto) };
  });

  app.post("/api/admin/items", async (request) => {
    const admin = requireAdmin(request);
    const body = objectBody(request.body);
    const categoryId = stringField(body, "categoryId", { min: 1, max: 100 })!;
    const category = getCategory(db, categoryId);
    const kind = enumField(body, "kind", ["word", "sentence"] as const, true) ?? category.kind;
    if (kind !== category.kind) badRequest("KIND_MISMATCH", "Item kind must match its category");
    const english = stringField(body, "english", { min: 1, max: 500 })!;
    const meaning = stringField(body, "meaning", { min: 1, max: 1000 })!;
    const pronunciation = stringField(body, "pronunciation", { optional: true, max: 500 }) ?? "";
    const sortOrder = integerField(body, "sortOrder", { optional: true, min: 0, max: 1_000_000 }) ?? 0;
    const key = stringField(body, "key", { optional: true, min: 1, max: 100 }) ?? `custom-${randomUUID()}`;
    ensureUniqueItemKey(db, key);
    const id = randomUUID();
    const now = Date.now();
    db.transaction(() => {
      db.prepare(`
        INSERT INTO items(
          id, item_key, category_id, kind, english, meaning, pronunciation, normalized_answer,
          sort_order, revision, status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 'draft', ?, ?)
      `).run(id, key, categoryId, kind, english, meaning, pronunciation, normalizeAnswer(english), sortOrder, now, now);
      addRevision(db, getItem(db, id), "create", admin.id);
      audit(db, request, "admin.item_created", "item", id, { key });
    })();
    return { item: itemDto(getItem(db, id)) };
  });

  app.patch("/api/admin/items/:id", async (request) => {
    const admin = requireAdmin(request);
    const id = idParam(request.params);
    const item = getItem(db, id);
    const body = objectBody(request.body);
    const key = stringField(body, "key", { optional: true, min: 1, max: 100 }) ?? item.item_key;
    ensureUniqueItemKey(db, key, id);
    const categoryId = stringField(body, "categoryId", { optional: true, min: 1, max: 100 }) ?? item.category_id;
    const category = getCategory(db, categoryId);
    const kind = enumField(body, "kind", ["word", "sentence"] as const, true) ?? item.kind;
    if (kind !== category.kind) badRequest("KIND_MISMATCH", "Item kind must match its category");
    const english = stringField(body, "english", { optional: true, min: 1, max: 500 }) ?? item.english;
    const meaning = stringField(body, "meaning", { optional: true, min: 1, max: 1000 }) ?? item.meaning;
    const pronunciation = stringField(body, "pronunciation", { optional: true, max: 500 }) ?? item.pronunciation;
    const sortOrder = integerField(body, "sortOrder", { optional: true, min: 0, max: 1_000_000 }) ?? item.sort_order;
    const now = Date.now();
    db.transaction(() => {
      db.prepare(`
        UPDATE items SET item_key = ?, category_id = ?, kind = ?, english = ?, meaning = ?, pronunciation = ?,
          normalized_answer = ?, sort_order = ?, revision = revision + 1,
          status = CASE WHEN status = 'published' THEN 'draft' ELSE status END,
          updated_at = ? WHERE id = ?
      `).run(key, categoryId, kind, english, meaning, pronunciation, normalizeAnswer(english), sortOrder, now, id);
      const updated = getItem(db, id);
      addRevision(db, updated, "update", admin.id);
      if (item.status === "published") bumpContentVersion(db);
      audit(db, request, "admin.item_updated", "item", id, { revision: updated.revision });
    })();
    return { item: itemDto(getItem(db, id)) };
  });

  const setItemStatus = (status: "published" | "archived") => async (request: FastifyRequest) => {
    const admin = requireAdmin(request);
    const id = idParam(request.params);
    const item = getItem(db, id);
    if (status === "published") {
      const category = getCategory(db, item.category_id);
      if (category.status !== "published") conflict("CATEGORY_NOT_PUBLISHED", "Publish the category before publishing this item");
    }
    const now = Date.now();
    db.transaction(() => {
      db.prepare(`
        UPDATE items SET status = ?, revision = revision + 1, updated_at = ?,
          published_at = CASE WHEN ? = 'published' THEN COALESCE(published_at, ?) ELSE published_at END,
          archived_at = CASE WHEN ? = 'archived' THEN ? ELSE NULL END
        WHERE id = ?
      `).run(status, now, status, now, status, now, id);
      const updated = getItem(db, id);
      addRevision(db, updated, status, admin.id);
      bumpContentVersion(db);
      audit(db, request, `admin.item_${status}`, "item", id, { previousStatus: item.status, revision: updated.revision });
    })();
    return { item: itemDto(getItem(db, id)) };
  };
  app.post("/api/admin/items/:id/publish", setItemStatus("published"));
  app.post("/api/admin/items/:id/archive", setItemStatus("archived"));
  app.delete("/api/admin/items/:id", setItemStatus("archived"));

  app.post(
    "/api/admin/imports/preview",
    { bodyLimit: 2_100_000, onRequest: async (request) => { requireAdmin(request); } },
    async (request) => {
    const admin = requireAdmin(request);
    const body = objectBody(request.body);
    const csv = stringField(body, "csv", { min: 1, max: 2_000_000, trim: false })!;
    const categoryId = stringField(body, "categoryId", { optional: true, min: 1, max: 100 });
    if (categoryId) getCategory(db, categoryId);
    const preview = parseImport(db, csv, categoryId);
    const id = randomUUID();
    const now = Date.now();
    db.prepare(`
      INSERT INTO import_previews(
        id, created_by, category_id, payload_json, errors_json, row_count, created_at, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, admin.id, categoryId ?? null, JSON.stringify(preview.rows), JSON.stringify(preview.errors), preview.rows.length, now, now + 30 * 60_000);
    audit(db, request, "admin.import_previewed", "import_preview", id, { rows: preview.rows.length, errors: preview.errors.length });
    return { previewId: id, rows: preview.rows, errors: preview.errors, expiresAt: new Date(now + 30 * 60_000).toISOString() };
    }
  );

  app.post("/api/admin/imports/commit", async (request) => {
    const admin = requireAdmin(request);
    const body = objectBody(request.body);
    const previewId = stringField(body, "previewId", { min: 1, max: 100 })!;
    const result = db.transaction(() => {
      revalidateAuthenticatedActor(db, request, admin, "admin");
      const now = Date.now();
      const preview = db.prepare("SELECT * FROM import_previews WHERE id = ? AND created_by = ?").get(previewId, admin.id) as
        | { id: string; payload_json: string; errors_json: string; expires_at: number; committed_at: number | null }
        | undefined;
      if (!preview) notFound("Import preview not found");
      if (preview.committed_at) conflict("IMPORT_ALREADY_COMMITTED", "Import preview has already been committed");
      if (preview.expires_at <= now) conflict("IMPORT_EXPIRED", "Import preview has expired");
      const errors = JSON.parse(preview.errors_json) as CsvError[];
      if (errors.length) badRequest("IMPORT_HAS_ERRORS", "Fix all preview errors before committing", { errors });
      const rows = JSON.parse(preview.payload_json) as CsvPreviewRow[];
      let created = 0;
      let updated = 0;
      for (const row of rows) {
        const category = getCategory(db, row.categoryId);
        if (category.kind !== row.kind) conflict("IMPORT_CATEGORY_CHANGED", `Category kind changed for CSV row ${row.row}`);
        const existing = db.prepare("SELECT * FROM items WHERE item_key = ?").get(row.key) as ItemRow | undefined;
        if (existing) {
          db.prepare(`
            UPDATE items SET category_id = ?, kind = ?, english = ?, meaning = ?, pronunciation = ?,
              normalized_answer = ?, sort_order = ?, status = ?, revision = revision + 1, updated_at = ?,
              published_at = CASE WHEN ? = 'published' THEN COALESCE(published_at, ?) ELSE published_at END,
              archived_at = NULL
            WHERE id = ?
          `).run(
            row.categoryId, row.kind, row.english, row.meaning, row.pronunciation, normalizeAnswer(row.english),
            row.sortOrder, row.status, now, row.status, now, existing.id
          );
          addRevision(db, getItem(db, existing.id), "csv_update", admin.id);
          updated += 1;
        } else {
          const id = randomUUID();
          db.prepare(`
            INSERT INTO items(
              id, item_key, category_id, kind, english, meaning, pronunciation, normalized_answer,
              sort_order, revision, status, created_at, updated_at, published_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)
          `).run(
            id, row.key, row.categoryId, row.kind, row.english, row.meaning, row.pronunciation,
            normalizeAnswer(row.english), row.sortOrder, row.status, now, now, row.status === "published" ? now : null
          );
          addRevision(db, getItem(db, id), "csv_create", admin.id);
          created += 1;
        }
      }
      const committed = db.prepare(`
        UPDATE import_previews SET committed_at = ?
        WHERE id = ? AND created_by = ? AND committed_at IS NULL AND expires_at > ?
      `).run(now, previewId, admin.id, now);
      if (committed.changes !== 1) conflict("IMPORT_STATE_CHANGED", "Import preview changed before it could be committed");
      bumpContentVersion(db);
      audit(db, request, "admin.import_committed", "import_preview", previewId, { created, updated });
      return { created, updated };
    }).immediate();
    return { ok: true, ...result };
  });

  app.get("/api/admin/audit", async (request) => {
    requireAdmin(request);
    const query = (request.query ?? {}) as Record<string, unknown>;
    const rawLimit = typeof query.limit === "string" ? Number(query.limit) : 50;
    if (!Number.isInteger(rawLimit) || rawLimit < 1 || rawLimit > 100) badRequest("INVALID_QUERY", "limit must be 1-100");
    const cursor = typeof query.cursor === "string" && /^\d+$/.test(query.cursor) ? Number(query.cursor) : undefined;
    const rows = (cursor
      ? db.prepare(`
          SELECT a.*, u.username AS actor_username FROM audit_log a LEFT JOIN users u ON u.id = a.actor_user_id
          WHERE a.id < ? ORDER BY a.id DESC LIMIT ?
        `).all(cursor, rawLimit)
      : db.prepare(`
          SELECT a.*, u.username AS actor_username FROM audit_log a LEFT JOIN users u ON u.id = a.actor_user_id
          ORDER BY a.id DESC LIMIT ?
        `).all(rawLimit)) as Array<{
          id: number; actor_user_id: string | null; actor_username: string | null; action: string;
          target_type: string | null; target_id: string | null; metadata_json: string; ip_address: string | null; created_at: number;
        }>;
    return {
      entries: rows.map((row) => ({
        id: row.id,
        actorUserId: row.actor_user_id,
        actorUsername: row.actor_username,
        action: row.action,
        targetType: row.target_type,
        targetId: row.target_id,
        metadata: JSON.parse(row.metadata_json) as unknown,
        ipAddress: row.ip_address,
        createdAt: new Date(row.created_at).toISOString()
      })),
      nextCursor: rows.length === rawLimit ? rows.at(-1)!.id : null
    };
  });
}

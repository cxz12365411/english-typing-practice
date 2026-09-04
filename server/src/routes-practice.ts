import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { SqliteDatabase } from "./database.js";
import { audit, requireUser } from "./auth.js";
import { ApiError, badRequest, conflict, notFound } from "./errors.js";
import { normalizeAnswer, tokenHash } from "./security.js";
import { enumField, idParam, integerField, objectBody, stringField } from "./validation.js";

interface ContentItemRow {
  id: string;
  item_key: string;
  kind: "word" | "sentence";
  category_id: string;
  english: string;
  meaning: string;
  pronunciation: string;
  normalized_answer: string;
  sort_order: number;
  revision: number;
}

interface PracticeSessionRow {
  id: string;
  user_id: string;
  mode: "sequential" | "random" | "mistakes";
  category_id: string | null;
  started_at: number;
  finished_at: number | null;
  duration_ms: number;
  total_attempts: number;
  correct_attempts: number;
  first_try_correct: number;
  current_streak: number;
  best_streak: number;
  last_attempt_at: number | null;
}

interface AttemptRow {
  id: string;
  client_attempt_id: string;
  practice_session_id: string;
  item_id: string;
  item_revision: number;
  request_hash: string;
  correct: number;
  first_try_correct: number;
  duration_ms: number;
  occurred_at: number;
}

const SESSION_CREATIONS_PER_MINUTE = 60;
const ATTEMPTS_PER_MINUTE = 120;

function attemptRequestHash(input: {
  sessionId: string;
  itemId: string;
  itemRevision: number;
  answer: string;
  durationMs: number;
  occurredAt: string | null;
}): string {
  return tokenHash(JSON.stringify({ ...input, answer: normalizeAnswer(input.answer) }));
}

function itemDto(row: ContentItemRow) {
  return {
    id: row.id,
    key: row.item_key,
    kind: row.kind,
    categoryId: row.category_id,
    english: row.english,
    meaning: row.meaning,
    pronunciation: row.pronunciation,
    sortOrder: row.sort_order,
    revision: row.revision
  };
}

function sessionSummary(row: PracticeSessionRow, lastAttempt?: AttemptRow) {
  return {
    sessionId: row.id,
    totalAttempts: row.total_attempts,
    correctAttempts: row.correct_attempts,
    firstTryCorrectCount: row.first_try_correct,
    accuracy: row.total_attempts ? row.correct_attempts / row.total_attempts : 0,
    currentStreak: row.current_streak,
    bestStreak: row.best_streak,
    durationMs: row.duration_ms,
    startedAt: new Date(row.started_at).toISOString(),
    ...(row.finished_at ? { finishedAt: new Date(row.finished_at).toISOString() } : {}),
    ...(lastAttempt
      ? {
          lastAttempt: {
            id: lastAttempt.id,
            correct: Boolean(lastAttempt.correct),
            firstTryCorrect: Boolean(lastAttempt.first_try_correct)
          }
        }
      : {})
  };
}

function attemptResponse(db: SqliteDatabase, userId: string, session: PracticeSessionRow, attempt: AttemptRow) {
  const mistakes = (db.prepare("SELECT COUNT(*) AS count FROM progress WHERE user_id = ? AND is_mistake = 1").get(userId) as {
    count: number;
  }).count;
  return {
    attempt: {
      clientAttemptId: attempt.client_attempt_id,
      itemId: attempt.item_id,
      itemRevision: attempt.item_revision,
      correct: Boolean(attempt.correct),
      completedAt: new Date(attempt.occurred_at).toISOString()
    },
    summary: {
      done: session.total_attempts,
      correct: session.correct_attempts,
      accuracy: session.total_attempts ? session.correct_attempts / session.total_attempts : 0,
      streak: session.current_streak,
      mistakes
    }
  };
}

function getOwnedSession(db: SqliteDatabase, id: string, userId: string): PracticeSessionRow {
  const row = db.prepare("SELECT * FROM practice_sessions WHERE id = ? AND user_id = ?").get(id, userId) as
    | PracticeSessionRow
    | undefined;
  if (!row) notFound("Practice session not found");
  return row;
}

function recomputeSessionAggregates(db: SqliteDatabase, sessionId: string, userId: string): PracticeSessionRow {
  const previousFirst = new Map(
    (db.prepare(`
      SELECT item_id, SUM(first_try_correct) AS count
      FROM attempts WHERE practice_session_id = ? GROUP BY item_id
    `).all(sessionId) as Array<{ item_id: string; count: number }>).map((row) => [row.item_id, row.count])
  );
  const attempts = db.prepare(`
    SELECT * FROM attempts
    WHERE practice_session_id = ?
    ORDER BY occurred_at ASC, client_attempt_id ASC, id ASC
  `).all(sessionId) as AttemptRow[];

  db.prepare("UPDATE attempts SET first_try_correct = 0 WHERE practice_session_id = ? AND first_try_correct <> 0").run(sessionId);
  const markFirstTry = db.prepare("UPDATE attempts SET first_try_correct = 1 WHERE id = ?");
  const firstByItem = new Map<string, number>();
  const seenItems = new Set<string>();
  let correctAttempts = 0;
  let currentStreak = 0;
  let bestStreak = 0;
  let durationMs = 0;
  for (const attempt of attempts) {
    correctAttempts += attempt.correct;
    durationMs += attempt.duration_ms;
    if (attempt.correct) {
      currentStreak += 1;
      bestStreak = Math.max(bestStreak, currentStreak);
    } else {
      currentStreak = 0;
    }
    if (!seenItems.has(attempt.item_id)) {
      seenItems.add(attempt.item_id);
      const firstTry = attempt.correct ? 1 : 0;
      firstByItem.set(attempt.item_id, firstTry);
      if (firstTry) markFirstTry.run(attempt.id);
    }
  }

  const updateProgress = db.prepare(`
    UPDATE progress
    SET first_try_correct_count = MAX(0, first_try_correct_count + ?), updated_at = ?
    WHERE user_id = ? AND item_id = ?
  `);
  const now = Date.now();
  for (const itemId of new Set([...previousFirst.keys(), ...firstByItem.keys()])) {
    const delta = (firstByItem.get(itemId) ?? 0) - (previousFirst.get(itemId) ?? 0);
    if (delta) updateProgress.run(delta, now, userId, itemId);
  }

  const firstTryCorrect = [...firstByItem.values()].reduce((sum, value) => sum + value, 0);
  const lastAttemptAt = attempts.at(-1)?.occurred_at ?? null;
  db.prepare(`
    UPDATE practice_sessions SET
      total_attempts = ?, correct_attempts = ?, first_try_correct = ?,
      current_streak = ?, best_streak = ?, duration_ms = ?, last_attempt_at = ?
    WHERE id = ? AND user_id = ?
  `).run(
    attempts.length,
    correctAttempts,
    firstTryCorrect,
    currentStreak,
    bestStreak,
    durationMs,
    lastAttemptAt,
    sessionId,
    userId
  );
  return getOwnedSession(db, sessionId, userId);
}

export async function registerPracticeRoutes(app: FastifyInstance, db: SqliteDatabase): Promise<void> {
  app.get("/api/content", async (request) => {
    requireUser(request);
    const version = (db.prepare("SELECT value FROM app_meta WHERE key = 'content_version'").get() as { value: string } | undefined)
      ?.value ?? "0";
    const categories = db.prepare(`
      SELECT id, slug, name, kind, sort_order
      FROM categories WHERE status = 'published'
      ORDER BY kind, sort_order, id
    `).all() as Array<{ id: string; slug: string; name: string; kind: string; sort_order: number }>;
    const items = db.prepare(`
      SELECT i.* FROM items i
      JOIN categories c ON c.id = i.category_id
      WHERE i.status = 'published' AND c.status = 'published'
      ORDER BY i.kind, c.sort_order, i.sort_order, i.id
    `).all() as ContentItemRow[];
    return {
      version,
      categories: categories.map((row) => ({
        id: row.id,
        slug: row.slug,
        name: row.name,
        kind: row.kind,
        sortOrder: row.sort_order
      })),
      items: items.map(itemDto)
    };
  });

  app.post("/api/practice/sessions", async (request) => {
    const user = requireUser(request);
    const body = objectBody(request.body);
    const mode = enumField(body, "mode", ["sequential", "random", "mistakes"] as const)!;
    const categoryId = stringField(body, "categoryId", { optional: true, min: 1, max: 100 });
    if (categoryId) {
      const category = db.prepare("SELECT id FROM categories WHERE id = ? AND status = 'published'").get(categoryId);
      if (!category) badRequest("INVALID_CATEGORY", "Category is not published", { field: "categoryId" });
    }
    const id = randomUUID();
    const startedAt = Date.now();
    db.transaction(() => {
      const recent = db.prepare(`
        SELECT COUNT(*) AS count FROM practice_sessions WHERE user_id = ? AND started_at >= ?
      `).get(user.id, startedAt - 60_000) as { count: number };
      if (recent.count >= SESSION_CREATIONS_PER_MINUTE) {
        throw new ApiError(429, "PRACTICE_SESSION_RATE_LIMITED", "Too many practice sessions; retry shortly");
      }
      db.prepare(`
        UPDATE practice_sessions
        SET finished_at = ?, duration_ms = MAX(duration_ms, ? - started_at)
        WHERE user_id = ? AND finished_at IS NULL
      `).run(startedAt, startedAt, user.id);
      db.prepare(`
        INSERT INTO practice_sessions(id, user_id, mode, category_id, started_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(id, user.id, mode, categoryId ?? null, startedAt);
    }).immediate();
    return { session: { id, startedAt: new Date(startedAt).toISOString() } };
  });

  app.post("/api/practice/sessions/:id/attempts", async (request) => {
    const user = requireUser(request);
    const sessionId = idParam(request.params);
    const body = objectBody(request.body);
    const clientAttemptId = stringField(body, "clientAttemptId", { min: 8, max: 100 })!;
    const itemId = stringField(body, "itemId", { min: 1, max: 100 })!;
    const itemRevision = integerField(body, "itemRevision", { min: 1, max: 2_147_483_647 })!;
    const answer = stringField(body, "answer", { min: 0, max: 500, trim: false })!;
    const durationMs = integerField(body, "durationMs", { min: 0, max: 3_600_000 })!;
    if (body.occurredAt !== undefined && typeof body.occurredAt !== "string") {
      badRequest("INVALID_FIELD", "occurredAt must be an ISO timestamp", { field: "occurredAt" });
    }
    const occurredAt = body.occurredAt === undefined ? Date.now() : Date.parse(body.occurredAt as string);
    if (!Number.isFinite(occurredAt)) {
      badRequest("INVALID_FIELD", "occurredAt must be an ISO timestamp", { field: "occurredAt" });
    }
    const occurredAtInput = body.occurredAt === undefined ? null : new Date(occurredAt).toISOString();
    const requestHash = attemptRequestHash({ sessionId, itemId, itemRevision, answer, durationMs, occurredAt: occurredAtInput });

    const readExisting = () => db.prepare(`
      SELECT * FROM attempts WHERE user_id = ? AND client_attempt_id = ?
    `).get(user.id, clientAttemptId) as AttemptRow | undefined;
    const replay = (existing: AttemptRow) => {
      if (existing.request_hash !== requestHash) {
        conflict("ATTEMPT_REPLAY_MISMATCH", "clientAttemptId was already used for a different attempt");
      }
      const originalSession = getOwnedSession(db, existing.practice_session_id, user.id);
      return attemptResponse(db, user.id, originalSession, existing);
    };
    const existing = readExisting();
    if (existing) return replay(existing);
    const acceptedAt = Date.now();
    if (occurredAt > acceptedAt + 5 * 60_000 || occurredAt < acceptedAt - 30 * 24 * 60 * 60_000) {
      badRequest("INVALID_FIELD", "occurredAt is outside the accepted time range", { field: "occurredAt" });
    }

    const submit = db.transaction((): { attempt: AttemptRow; session: PracticeSessionRow } | { replay: AttemptRow } => {
      const raced = readExisting();
      if (raced) return { replay: raced };
      const now = Date.now();
      const recent = db.prepare("SELECT COUNT(*) AS count FROM attempts WHERE user_id = ? AND created_at >= ?").get(
        user.id,
        now - 60_000
      ) as { count: number };
      if (recent.count >= ATTEMPTS_PER_MINUTE) {
        throw new ApiError(429, "ATTEMPT_RATE_LIMITED", "Too many attempts; retry shortly");
      }
      let session = getOwnedSession(db, sessionId, user.id);
      if (session.finished_at) conflict("SESSION_FINISHED", "Practice session has already finished");
      const itemState = db.prepare(`
        SELECT i.*, c.status AS category_status
        FROM items i JOIN categories c ON c.id = i.category_id
        WHERE i.id = ?
      `).get(itemId) as (ContentItemRow & { status: string; category_status: string }) | undefined;
      if (!itemState) notFound("Content item not found");
      if (itemState.revision !== itemRevision) {
        conflict("CONTENT_CHANGED", "Content changed after it was loaded", { currentRevision: itemState.revision });
      }
      if (itemState.status !== "published" || itemState.category_status !== "published") {
        conflict("CONTENT_UNAVAILABLE", "Content item is no longer published");
      }
      if (session.category_id && session.category_id !== itemState.category_id) {
        badRequest("ITEM_OUTSIDE_SESSION", "Item does not belong to the practice session category");
      }
      if (session.mode === "mistakes") {
        const mistake = db.prepare("SELECT 1 FROM progress WHERE user_id = ? AND item_id = ? AND is_mistake = 1").get(user.id, itemId);
        if (!mistake) badRequest("ITEM_NOT_A_MISTAKE", "Item is not in the user's current mistake list");
      }
      const correct = normalizeAnswer(answer) === itemState.normalized_answer;
      const attempt: AttemptRow = {
        id: randomUUID(),
        client_attempt_id: clientAttemptId,
        practice_session_id: sessionId,
        item_id: itemId,
        item_revision: itemRevision,
        request_hash: requestHash,
        correct: correct ? 1 : 0,
        first_try_correct: 0,
        duration_ms: durationMs,
        occurred_at: occurredAt
      };
      db.prepare(`
        INSERT INTO attempts(
          id, client_attempt_id, practice_session_id, user_id, item_id, item_revision, request_hash,
          correct, first_try_correct, duration_ms, occurred_at, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        attempt.id,
        clientAttemptId,
        sessionId,
        user.id,
        itemId,
        itemRevision,
        requestHash,
        attempt.correct,
        attempt.first_try_correct,
        durationMs,
        occurredAt,
        now
      );
      db.prepare(`
        INSERT INTO progress(
          user_id, item_id, attempt_count, correct_count, first_try_correct_count,
          wrong_count, is_mistake, last_attempt_at, last_wrong_at, updated_at
        ) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(user_id, item_id) DO UPDATE SET
          attempt_count = progress.attempt_count + 1,
          correct_count = progress.correct_count + excluded.correct_count,
          first_try_correct_count = progress.first_try_correct_count + excluded.first_try_correct_count,
          wrong_count = progress.wrong_count + excluded.wrong_count,
          is_mistake = CASE
            WHEN progress.last_attempt_at IS NULL OR excluded.last_attempt_at >= progress.last_attempt_at THEN excluded.is_mistake
            ELSE progress.is_mistake
          END,
          last_attempt_at = CASE
            WHEN progress.last_attempt_at IS NULL OR excluded.last_attempt_at >= progress.last_attempt_at THEN excluded.last_attempt_at
            ELSE progress.last_attempt_at
          END,
          last_wrong_at = CASE
            WHEN excluded.last_wrong_at IS NULL THEN progress.last_wrong_at
            WHEN progress.last_wrong_at IS NULL OR excluded.last_wrong_at > progress.last_wrong_at THEN excluded.last_wrong_at
            ELSE progress.last_wrong_at
          END,
          updated_at = excluded.updated_at
      `).run(
        user.id,
        itemId,
        correct ? 1 : 0,
        0,
        correct ? 0 : 1,
        correct ? 0 : 1,
        occurredAt,
        correct ? null : occurredAt,
        now
      );
      session = recomputeSessionAggregates(db, sessionId, user.id);
      const recomputedAttempt = db.prepare("SELECT * FROM attempts WHERE id = ?").get(attempt.id) as AttemptRow;
      return { attempt: recomputedAttempt, session };
    });

    try {
      const result = submit.immediate();
      if ("replay" in result) return replay(result.replay);
      return attemptResponse(db, user.id, result.session, result.attempt);
    } catch (error) {
      const code = (error as { code?: string }).code ?? "";
      if (code.startsWith("SQLITE_CONSTRAINT")) {
        const raced = readExisting();
        if (raced) return replay(raced);
      }
      throw error;
    }
  });

  app.post("/api/practice/sessions/:id/finish", async (request) => {
    const user = requireUser(request);
    const sessionId = idParam(request.params);
    const body = objectBody(request.body ?? {});
    const providedDuration = integerField(body, "durationMs", { min: 0, max: 24 * 60 * 60_000, optional: true });
    let session = getOwnedSession(db, sessionId, user.id);
    if (!session.finished_at) {
      const now = Date.now();
      const duration = providedDuration ?? Math.max(session.duration_ms, now - session.started_at);
      db.prepare("UPDATE practice_sessions SET finished_at = ?, duration_ms = ? WHERE id = ?").run(now, duration, sessionId);
      session = getOwnedSession(db, sessionId, user.id);
    }
    return { session: sessionSummary(session) };
  });

  app.get("/api/me/summary", async (request) => {
    const user = requireUser(request);
    const totals = db.prepare(`
      SELECT
        COUNT(*) AS sessions,
        COALESCE(SUM(total_attempts), 0) AS attempts,
        COALESCE(SUM(correct_attempts), 0) AS correct,
        COALESCE(SUM(first_try_correct), 0) AS first_try_correct,
        COALESCE(MAX(best_streak), 0) AS best_streak,
        COALESCE(SUM(duration_ms), 0) AS duration_ms
      FROM practice_sessions WHERE user_id = ?
    `).get(user.id) as {
      sessions: number;
      attempts: number;
      correct: number;
      first_try_correct: number;
      best_streak: number;
      duration_ms: number;
    };
    const mistakes = (db.prepare("SELECT COUNT(*) AS count FROM progress WHERE user_id = ? AND is_mistake = 1").get(user.id) as {
      count: number;
    }).count;
    const recent = db.prepare(`
      SELECT * FROM practice_sessions WHERE user_id = ? ORDER BY started_at DESC LIMIT 20
    `).all(user.id) as PracticeSessionRow[];
    return {
      totals: {
        sessions: totals.sessions,
        attempts: totals.attempts,
        correct: totals.correct,
        firstTryCorrect: totals.first_try_correct,
        accuracy: totals.attempts ? totals.correct / totals.attempts : 0,
        bestStreak: totals.best_streak,
        durationMs: totals.duration_ms,
        mistakes
      },
      recentSessions: recent.map((row) => sessionSummary(row))
    };
  });

  app.get("/api/me/mistakes", async (request) => {
    const user = requireUser(request);
    const rows = db.prepare(`
      SELECT i.*, p.wrong_count, p.last_wrong_at
      FROM progress p JOIN items i ON i.id = p.item_id
      WHERE p.user_id = ? AND p.is_mistake = 1
      ORDER BY p.last_wrong_at DESC, i.id
    `).all(user.id) as Array<ContentItemRow & { wrong_count: number; last_wrong_at: number }>;
    return {
      items: rows.map((row) => ({
        item: itemDto(row),
        wrongCount: row.wrong_count,
        lastWrongAt: new Date(row.last_wrong_at).toISOString()
      }))
    };
  });

  app.post(
    "/api/me/mistakes/import",
    { bodyLimit: 256 * 1024, onRequest: async (request) => { requireUser(request); } },
    async (request) => {
    const user = requireUser(request);
    const body = objectBody(request.body);
    if (
      !Array.isArray(body.answers) ||
      body.answers.length > 2_000 ||
      body.answers.some((value) => typeof value !== "string" || value.length > 500)
    ) {
      badRequest("INVALID_FIELD", "answers must be an array of at most 2000 strings (500 characters each)", { field: "answers" });
    }
    const existing = db.prepare("SELECT imported_count FROM user_imports WHERE user_id = ? AND import_kind = 'legacy_mistakes'").get(
      user.id
    ) as { imported_count: number } | undefined;
    if (existing) return { alreadyImported: true, imported: existing.imported_count, unmatched: 0 };

    const uniqueAnswers = [...new Set((body.answers as string[]).map(normalizeAnswer).filter(Boolean))];
    const find = db.prepare("SELECT id FROM items WHERE normalized_answer = ?");
    const matchedIds = new Set<string>();
    let unmatched = 0;
    for (const answer of uniqueAnswers) {
      const matches = find.all(answer) as Array<{ id: string }>;
      if (!matches.length) unmatched += 1;
      for (const row of matches) matchedIds.add(row.id);
    }
    const now = Date.now();
    db.transaction(() => {
      const insert = db.prepare(`
        INSERT INTO progress(
          user_id, item_id, attempt_count, correct_count, first_try_correct_count,
          wrong_count, is_mistake, last_attempt_at, last_wrong_at, updated_at
        ) VALUES (?, ?, 0, 0, 0, 1, 1, NULL, ?, ?)
        ON CONFLICT(user_id, item_id) DO UPDATE SET
          wrong_count = MAX(progress.wrong_count, 1), is_mistake = 1,
          last_wrong_at = COALESCE(progress.last_wrong_at, excluded.last_wrong_at), updated_at = excluded.updated_at
      `);
      for (const itemId of matchedIds) insert.run(user.id, itemId, now, now);
      db.prepare(`
        INSERT INTO user_imports(user_id, import_kind, imported_at, imported_count)
        VALUES (?, 'legacy_mistakes', ?, ?)
      `).run(user.id, now, matchedIds.size);
      audit(db, request, "mistakes.legacy_imported", "user", user.id, { imported: matchedIds.size, unmatched });
    })();
    return { alreadyImported: false, imported: matchedIds.size, unmatched };
    }
  );
}

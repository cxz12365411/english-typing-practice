import type { FastifyRequest } from "fastify";
import { requireUser, type UserRow } from "./auth.js";
import type { SqliteDatabase } from "./database.js";
import { ApiError } from "./errors.js";

export const MEMBERSHIP_PLAN = Object.freeze({ id: "monthly", priceFen: 100, durationDays: 30 });
const DAY_MS = 24 * 60 * 60_000;

export interface MembershipRow {
  user_id: string;
  access_kind: "legacy_free" | "metered";
  trial_started_at: number | null;
  trial_ends_at: number | null;
  paid_until: number | null;
  updated_at: number;
}

export interface MembershipAccess {
  status: "disabled" | "admin" | "legacy_free" | "trial" | "active" | "expired";
  canPractice: boolean;
  trialEndsAt: string | null;
  paidUntil: string | null;
  expiresAt: string | null;
}

export function getMembershipAccess(
  db: SqliteDatabase,
  user: Pick<UserRow, "id" | "role">,
  enabled: boolean,
  now = Date.now()
): MembershipAccess {
  const row = db.prepare("SELECT * FROM user_memberships WHERE user_id = ?").get(user.id) as MembershipRow | undefined;
  const trial = row?.trial_ends_at ?? 0;
  const paid = row?.paid_until ?? 0;
  const unlimited = !enabled || user.role === "admin" || row?.access_kind === "legacy_free";
  const expiry = Math.max(trial, paid);
  const status: MembershipAccess["status"] = !enabled ? "disabled"
    : user.role === "admin" ? "admin"
    : row?.access_kind === "legacy_free" ? "legacy_free"
    : paid > now ? "active"
    : trial > now ? "trial" : "expired";
  return {
    status,
    canPractice: unlimited || expiry > now,
    trialEndsAt: trial ? new Date(trial).toISOString() : null,
    paidUntil: paid ? new Date(paid).toISOString() : null,
    expiresAt: unlimited || !expiry ? null : new Date(expiry).toISOString()
  };
}

export function requirePracticeAccess(db: SqliteDatabase, request: FastifyRequest, enabled: boolean): UserRow {
  const user = requireUser(request);
  const access = getMembershipAccess(db, user, enabled);
  if (!access.canPractice) {
    throw new ApiError(403, "MEMBERSHIP_REQUIRED", "Trial or membership has expired", { access });
  }
  return user;
}

/** Call inside the payment's transaction, together with its single-use paid marker. */
export function extendMembership(db: SqliteDatabase, userId: string, durationDays: number, now = Date.now()): number {
  if (durationDays !== MEMBERSHIP_PLAN.durationDays || !Number.isSafeInteger(now)) {
    throw new Error("Invalid membership extension");
  }
  const row = db.prepare("SELECT * FROM user_memberships WHERE user_id = ?").get(userId) as MembershipRow | undefined;
  if (!row) throw new Error("Membership state is missing");
  const paidUntil = Math.max(now, row.paid_until ?? 0, row.trial_ends_at ?? 0) + durationDays * DAY_MS;
  if (!Number.isSafeInteger(paidUntil) || paidUntil > 8_640_000_000_000_000) throw new Error("Membership expiry out of range");
  db.prepare("UPDATE user_memberships SET paid_until = ?, updated_at = ? WHERE user_id = ?").run(paidUntil, now, userId);
  return paidUntil;
}

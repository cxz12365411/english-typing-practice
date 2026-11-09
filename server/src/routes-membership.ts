import type { FastifyInstance } from "fastify";
import { audit, requireUser, revalidateAuthenticatedActor, toUserDto, type UserRow } from "./auth.js";
import type { SqliteDatabase } from "./database.js";
import { getMembershipAccess, MEMBERSHIP_PLAN } from "./membership.js";
import { objectBody, stringField } from "./validation.js";

export interface MembershipRouteOptions {
  membershipEnabled: boolean;
  paymentEnabled: boolean;
  paymentMode: "disabled" | "sandbox" | "live" | "test";
}

export async function registerMembershipRoutes(
  app: FastifyInstance, db: SqliteDatabase, options: MembershipRouteOptions
): Promise<void> {
  app.patch("/api/me/profile", async (request) => {
    const user = requireUser(request);
    const displayName = stringField(objectBody(request.body), "displayName", { min: 1, max: 80 })!;
    return db.transaction(() => {
      revalidateAuthenticatedActor(db, request, user);
      db.prepare("UPDATE users SET display_name = ?, updated_at = ? WHERE id = ?").run(displayName, Date.now(), user.id);
      audit(db, request, "user.profile_updated", "user", user.id);
      return { user: toUserDto(db.prepare("SELECT * FROM users WHERE id = ?").get(user.id) as UserRow) };
    }).immediate();
  });
  app.get("/api/membership", async (request) => {
    const user = requireUser(request);
    const now = Date.now();
    return {
      enabled: options.membershipEnabled,
      access: getMembershipAccess(db, user, options.membershipEnabled, now),
      plan: MEMBERSHIP_PLAN,
      paymentEnabled: options.membershipEnabled && options.paymentEnabled,
      paymentMode: options.paymentMode,
      serverTime: new Date(now).toISOString()
    };
  });
}

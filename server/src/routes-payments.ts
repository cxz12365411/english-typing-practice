import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { audit, requireUser, revalidateAuthenticatedActor } from "./auth.js";
import type { SqliteDatabase } from "./database.js";
import { ApiError } from "./errors.js";
import { extendMembership } from "./membership.js";
import { ALIPAY_NOTIFY_PATH, type PaymentProvider, type VerifiedPayment } from "./payment-provider.js";

interface OrderRow {
  id: string; user_id: string; app_id: string; seller_id: string;
  amount_fen: number; duration_days: number; provider_mode: string;
  status: "pending" | "paid" | "closed"; created_at: number; expires_at: number;
  paid_at: number | null; provider_trade_no: string | null;
  credited_until: number | null; last_checked_at: number | null; updated_at: number;
}
const ORDER_TTL = 15 * 60_000;
const QUERY_COOLDOWN = 5_000;
const date = (value: number | null) => value === null ? null : new Date(value).toISOString();

function currentProvider(order: OrderRow, provider: PaymentProvider): boolean {
  return order.provider_mode === provider.mode && order.app_id === provider.appId && order.seller_id === provider.sellerId;
}
function publicOrder(order: OrderRow) {
  return {
    id: order.id, status: order.status === "pending" && order.expires_at <= Date.now() ? "expired" : order.status,
    amountFen: order.amount_fen, durationDays: order.duration_days,
    createdAt: date(order.created_at), expiresAt: date(order.expires_at), paidAt: date(order.paid_at),
    creditedUntil: date(order.credited_until)
  };
}

/** Caller must have verified the provider signature or authenticated query first. */
export function applyVerifiedPayment(db: SqliteDatabase, provider: PaymentProvider, event: VerifiedPayment, now = Date.now()): boolean {
  return db.transaction(() => {
    const order = db.prepare("SELECT * FROM payment_orders WHERE id = ?").get(event.orderId) as OrderRow | undefined;
    if (!order || !currentProvider(order, provider) || event.appId !== order.app_id || event.sellerId !== order.seller_id
      || event.amountFen !== order.amount_fen || event.amountFen !== 100 || !event.tradeNo) return false;
    if (order.status === "paid") return event.tradeNo === order.provider_trade_no;
    if (event.status === "paid") {
      const duplicate = db.prepare("SELECT id FROM payment_orders WHERE provider_trade_no = ? AND id <> ?").get(event.tradeNo, order.id);
      if (duplicate) return false;
      const creditedUntil = extendMembership(db, order.user_id, order.duration_days, now);
      db.prepare(`UPDATE payment_orders SET status = 'paid', provider_trade_no = ?, paid_at = ?,
        credited_until = ?, updated_at = ? WHERE id = ?`).run(event.tradeNo, now, creditedUntil, now, order.id);
      db.prepare(`INSERT INTO audit_log(actor_user_id, action, target_type, target_id, metadata_json, created_at)
        VALUES (NULL, 'membership.payment_credited', 'payment_order', ?, ?, ?)`).run(
          order.id, JSON.stringify({ userId: order.user_id, amountFen: order.amount_fen, durationDays: order.duration_days }), now);
    } else if (event.status === "closed") {
      db.prepare("UPDATE payment_orders SET status = 'closed', updated_at = ? WHERE id = ?").run(now, order.id);
    }
    // A late but verified success is still credited after a local timeout or an
    // earlier CLOSED event. Never undo an entitlement on a reordered notification.
    return true;
  }).immediate();
}

export async function registerPaymentRoutes(
  app: FastifyInstance, db: SqliteDatabase, provider: PaymentProvider,
  options: { membershipEnabled: boolean; paymentPreviewUserId?: string | undefined }
): Promise<void> {
  const readOrder = (id: string) => db.prepare("SELECT * FROM payment_orders WHERE id = ?").get(id) as OrderRow | undefined;
  const response = (order: OrderRow) => ({
    order: publicOrder(order), paymentMode: provider.mode,
    paymentUrl: (options.membershipEnabled || order.user_id === options.paymentPreviewUserId) && currentProvider(order, provider) && provider.mode !== "disabled"
      && order.status === "pending" && order.expires_at > Date.now()
      ? provider.paymentUrl({ id: order.id, amountFen: order.amount_fen, expiresAt: order.expires_at }) : null,
    retryAfterSeconds: QUERY_COOLDOWN / 1000
  });

  app.post("/api/payments/orders", async (request, reply) => {
    const actor = requireUser(request);
    if ((!options.membershipEnabled && actor.id !== options.paymentPreviewUserId) || provider.mode === "disabled") throw new ApiError(503, "PAYMENTS_DISABLED", "Payments are not enabled");
    const body = request.body as Record<string, unknown> | undefined;
    if (body !== undefined && (body === null || Array.isArray(body) || typeof body !== "object"
      || Object.keys(body).some(key => key !== "planId") || (body.planId !== undefined && body.planId !== "monthly"))) {
      throw new ApiError(422, "INVALID_PAYMENT_PLAN", "Only the monthly plan is available");
    }
    const order = db.transaction(() => {
      const user = revalidateAuthenticatedActor(db, request, actor);
      const membership = db.prepare("SELECT access_kind FROM user_memberships WHERE user_id = ?").get(user.id) as { access_kind: string } | undefined;
      if (!membership) throw new ApiError(409, "MEMBERSHIP_UNAVAILABLE", "Membership state unavailable");
      if (user.role === "admin" || membership.access_kind === "legacy_free") throw new ApiError(409, "MEMBERSHIP_NOT_REQUIRED", "This account already has free access");
      const now = Date.now();
      const reusable = db.prepare(`SELECT * FROM payment_orders WHERE user_id = ? AND provider_mode = ?
        AND app_id = ? AND seller_id = ? AND status = 'pending' AND expires_at > ? ORDER BY created_at DESC LIMIT 1`)
        .get(user.id, provider.mode, provider.appId, provider.sellerId, now) as OrderRow | undefined;
      if (reusable) return reusable;
      const rate = db.prepare(`SELECT COUNT(*) AS total, SUM(created_at > ?) AS hourly FROM payment_orders
        WHERE user_id = ? AND created_at > ?`).get(now - 3600_000, user.id, now - 86400_000) as { total: number; hourly: number };
      if (rate.total >= 20 || rate.hourly >= 10) throw new ApiError(429, "PAYMENT_RATE_LIMITED", "Too many payment orders", { retryAfterSeconds: 3600 });
      const id = `ET${randomUUID().replaceAll("-", "")}`;
      db.prepare(`INSERT INTO payment_orders(id,user_id,app_id,seller_id,amount_fen,duration_days,provider_mode,status,created_at,expires_at,updated_at)
        VALUES(?,?,?,?,100,30,?,'pending',?,?,?)`).run(id, user.id, provider.appId, provider.sellerId, provider.mode, now, now + ORDER_TTL, now);
      audit(db, request, "payment.order_created", "payment_order", id, { amountFen: 100, durationDays: 30 });
      return readOrder(id)!;
    }).immediate();
    return reply.status(201).send(response(order));
  });

  app.get("/api/payments/orders", async request => {
    const user = requireUser(request);
    return { orders: (db.prepare("SELECT * FROM payment_orders WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT 20")
      .all(user.id) as OrderRow[]).map(publicOrder) };
  });

  app.get("/api/payments/orders/:id", async request => {
    const user = requireUser(request);
    const id = (request.params as { id: string }).id;
    let order = readOrder(id);
    if (!order || order.user_id !== user.id) throw new ApiError(404, "NOT_FOUND", "Order not found");
    if (provider.mode !== "disabled" && currentProvider(order, provider) && order.status !== "paid") {
      const now = Date.now();
      // The persisted compare-and-set works across processes, request races and restarts.
      const claimed = db.prepare(`UPDATE payment_orders SET last_checked_at = ? WHERE id = ? AND status <> 'paid'
        AND (last_checked_at IS NULL OR last_checked_at <= ?)`).run(now, order.id, now - QUERY_COOLDOWN).changes;
      if (claimed) {
        try {
          const event = await provider.query(order.id);
          if (event && (event.orderId !== order.id || !applyVerifiedPayment(db, provider, event))) throw new Error("Payment verification mismatch");
        } catch {
          // Do not expose SDK errors: they may embed signed requests, keys or buyer data.
          throw new ApiError(503, "PAYMENT_QUERY_UNAVAILABLE", "Payment confirmation is temporarily unavailable");
        }
        order = readOrder(id)!;
      }
    }
    // Payment confirmation is durable even if the browser session is revoked while
    // querying Alipay. The revoked caller must not receive private order details.
    revalidateAuthenticatedActor(db, request, user);
    return response(order);
  });

  // Queue this encapsulated parser without awaiting Fastify itself. Awaiting
  // app.register() boots existing routes before the root error handler is installed.
  app.register(async scope => {
    scope.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "string", bodyLimit: 16_384 }, (request, body, done) => {
      if (request.routeOptions.url !== ALIPAY_NOTIFY_PATH) return done(new ApiError(415, "BAD_REQUEST", "Unsupported content type"));
      const fields: Record<string, string> = Object.create(null) as Record<string, string>;
      const params = new URLSearchParams(String(body));
      for (const [key, value] of params) {
        if (!/^[a-zA-Z0-9_]+$/.test(key) || ["__proto__", "constructor", "prototype"].includes(key)
          || Object.hasOwn(fields, key) || Object.keys(fields).length >= 80) {
          return done(new ApiError(400, "INVALID_NOTIFICATION", "Invalid notification"));
        }
        fields[key] = value;
      }
      done(null, fields);
    });
    scope.post(ALIPAY_NOTIFY_PATH, { bodyLimit: 16_384 }, async (request, reply) => {
      reply.type("text/plain; charset=utf-8");
      if (provider.mode === "disabled") return reply.code(503).send("failure");
      if (!(request.headers["content-type"] ?? "").toLowerCase().startsWith("application/x-www-form-urlencoded")) return reply.code(415).send("failure");
      try {
        const event = provider.verifyNotification(request.body as Record<string, string>);
        if (!event || !applyVerifiedPayment(db, provider, event)) return reply.code(400).send("failure");
        return "success";
      } catch {
        return reply.code(400).send("failure");
      }
    });
  });
}

import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import type { AppConfig } from "./config.js";
import { loadConfig } from "./config.js";
import { cleanupExpiredSecurityRows, loadSession, requireCsrf } from "./auth.js";
import { migrateAndSeed, openDatabase, type SqliteDatabase } from "./database.js";
import { ApiError } from "./errors.js";
import { registerAdminRoutes } from "./routes-admin.js";
import { registerAuthRoutes } from "./routes-auth.js";
import { registerPracticeRoutes } from "./routes-practice.js";
import { PasswordWorkQueueFullError } from "./security.js";
import { createEmailProvider, type EmailProvider } from "./email-provider.js";
import { emailAuthCapabilities, registerEmailAuthRoutes } from "./routes-email-auth.js";

export interface BuildAppOptions {
  config?: Partial<AppConfig>;
  database?: SqliteDatabase;
  migrate?: boolean;
  seed?: boolean;
  logger?: boolean;
  emailProvider?: EmailProvider;
}

const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

function isLoopbackAddress(address: string): boolean {
  return address === "::1" || /^127(?:\.\d{1,3}){3}$/.test(address) || /^::ffff:127(?:\.\d{1,3}){3}$/i.test(address);
}

export async function buildApp(options: BuildAppOptions = {}): Promise<FastifyInstance> {
  const config = loadConfig(options.config);
  const emailProvider = options.emailProvider ?? createEmailProvider(config.emailDelivery, config.environment);
  if (emailProvider.kind === "test" && config.environment !== "test") {
    throw new Error("The test email provider is permitted only when NODE_ENV=test");
  }
  const app = Fastify({
    logger: options.logger === false ? false : { level: config.logLevel },
    trustProxy: config.trustProxy === "loopback" ? (address, hop) => hop === 0 && isLoopbackAddress(address) : false,
    bodyLimit: 64 * 1024
  });
  const db = options.database ?? openDatabase(config);
  if (options.migrate !== false) {
    if (options.seed === false) {
      const { migrateDatabase } = await import("./database.js");
      migrateDatabase(db);
    } else {
      migrateAndSeed(db, config.contentSourceDir);
    }
  }

  await app.register(cookie);
  app.decorateRequest("authSession", null);

  app.addHook("onRequest", async (_request, reply) => {
    reply.header("Cache-Control", "no-store");
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("Referrer-Policy", "same-origin");
  });

  const loadAndValidateRequestSecurity = (request: Parameters<typeof loadSession>[1], reply: Parameters<typeof loadSession>[2]): void => {
    request.authSession = loadSession(db, request, reply, config.guestTokenSecret);
    if (!MUTATING_METHODS.has(request.method)) return;
    if (request.headers.origin !== config.appOrigin) {
      throw new ApiError(403, "ORIGIN_INVALID", "Request origin is not allowed");
    }
    requireCsrf(request);
  };

  // Reject unauthenticated/cross-origin writes before Fastify parses a body. The
  // preHandler check then reloads the session after parsing so a concurrent revoke,
  // password reset or role change still wins before the handler mutates state.
  app.addHook("onRequest", async (request, reply) => {
    loadAndValidateRequestSecurity(request, reply);
  });

  app.addHook("preHandler", async (request, reply) => {
    if (!MUTATING_METHODS.has(request.method)) return;
    loadAndValidateRequestSecurity(request, reply);
  });

  app.get("/api/healthz", async () => {
    db.prepare("SELECT 1").get();
    const migration = db.prepare("SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations").get() as { version: number };
    return { ok: true, database: "ok", schemaVersion: migration.version };
  });

  const emailOptions = {
    selfRegistrationEnabled: config.emailSelfRegistration,
    dailySendLimit: config.emailDailySendLimit,
    registrationDailySendLimit: config.emailRegistrationDailySendLimit,
    registrationIpDailyLimit: config.emailRegistrationIpDailyLimit
  };
  await registerAuthRoutes(app, db, config.guestTokenSecret, emailAuthCapabilities(emailProvider, emailOptions));
  const closeEmailAuth = await registerEmailAuthRoutes(app, db, emailProvider, config.emailCodeSecret, emailOptions);
  await registerPracticeRoutes(app, db);
  await registerAdminRoutes(app, db);

  app.setNotFoundHandler(async (_request, reply) => {
    return reply.status(404).send({ error: { code: "NOT_FOUND", message: "API endpoint not found" } });
  });

  app.setErrorHandler(async (error, request, reply) => {
    if (error instanceof ApiError) {
      return reply.status(error.statusCode).send({
        error: {
          code: error.code,
          message: error.message,
          ...(error.details === undefined ? {} : { details: error.details })
        }
      });
    }
    if (error instanceof PasswordWorkQueueFullError) {
      return reply.status(503).send({ error: { code: "AUTH_CAPACITY", message: "Authentication service is busy; retry shortly" } });
    }
    const fastifyError = error as { code?: string; statusCode?: number; validation?: unknown };
    if (fastifyError.validation) {
      return reply.status(422).send({
        error: { code: "VALIDATION_ERROR", message: "Request validation failed", details: fastifyError.validation }
      });
    }
    if (fastifyError.code === "FST_ERR_CTP_BODY_TOO_LARGE") {
      return reply.status(413).send({ error: { code: "BODY_TOO_LARGE", message: "Request body is too large" } });
    }
    if (fastifyError.statusCode && fastifyError.statusCode >= 400 && fastifyError.statusCode < 500) {
      const malformedJson = fastifyError.statusCode === 400 && /json/i.test(
        `${fastifyError.code ?? ""} ${error instanceof Error ? error.message : ""}`
      );
      return reply.status(fastifyError.statusCode).send({
        error: {
          code: malformedJson ? "INVALID_JSON" : "BAD_REQUEST",
          message: malformedJson ? "Request body is not valid JSON" : "Request could not be processed"
        }
      });
    }
    if (fastifyError.code?.startsWith("SQLITE_CONSTRAINT")) {
      return reply.status(409).send({ error: { code: "DATABASE_CONFLICT", message: "The requested change conflicts with existing data" } });
    }
    request.log.error({ err: error }, "Unhandled API error");
    return reply.status(500).send({ error: { code: "INTERNAL_ERROR", message: "Internal server error" } });
  });

  const cleanupTimer = setInterval(() => cleanupExpiredSecurityRows(db), 60 * 60_000);
  cleanupTimer.unref();
  app.addHook("onClose", async () => {
    clearInterval(cleanupTimer);
    await closeEmailAuth();
    if (!options.database) db.close();
  });

  return app;
}

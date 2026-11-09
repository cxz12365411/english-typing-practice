import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { FastifyInstance } from "fastify";
import { locateContentSource, type SqliteDatabase } from "./database.js";
import { requirePracticeAccess } from "./membership.js";
import { ApiError } from "./errors.js";

const RESOURCE_NAMES = ["sentence-alignments.json", "cet4-writing.json", "cet6-writing.json"] as const;

/** Same canonical sources as the static practice, delivered only to authorized learners. */
export async function registerContentResourceRoutes(
  app: FastifyInstance,
  db: SqliteDatabase,
  options: { membershipEnabled: boolean; contentSourceDir?: string }
): Promise<void> {
  const cache = new Map<string, string>();
  for (const name of RESOURCE_NAMES) {
    app.get(`/api/content-resources/${name}`, async (request, reply) => {
      requirePracticeAccess(db, request, options.membershipEnabled);
      let content = cache.get(name);
      if (!content) {
        try {
          content = readFileSync(resolve(locateContentSource(options.contentSourceDir), name), "utf8");
          JSON.parse(content);
          cache.set(name, content);
        } catch {
          throw new ApiError(503, "CONTENT_RESOURCE_UNAVAILABLE", "学习辅助资料暂不可用，请继续逐句练习");
        }
      }
      return reply.type("application/json; charset=utf-8").send(content);
    });
  }
}

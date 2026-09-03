import path from "node:path";
import { randomBytes } from "node:crypto";

export interface AppConfig {
  host: string;
  port: number;
  databasePath: string;
  appOrigin: string;
  logLevel: string;
  trustProxy: false | "loopback";
  guestTokenSecret: string;
  contentSourceDir?: string;
}

function parseTrustProxy(value: string | undefined): false | "loopback" {
  if (value === undefined || value.trim().toLowerCase() === "loopback") return "loopback";
  if (value.trim().toLowerCase() === "false") return false;
  throw new Error("TRUST_PROXY must be either 'loopback' or 'false'; arbitrary proxies are not trusted");
}

function guestTokenSecret(value: string | undefined): string {
  if (value === undefined) return randomBytes(32).toString("base64url");
  if (Buffer.byteLength(value, "utf8") < 32) throw new Error("GUEST_TOKEN_SECRET must be at least 32 bytes");
  return value;
}

function parsePort(value: string | undefined): number {
  if (!value) return 8091;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("PORT must be an integer between 1 and 65535");
  }
  return port;
}

function normalizeOrigin(value: string): string {
  const parsed = new URL(value);
  if (!/^https?:$/.test(parsed.protocol) || parsed.pathname !== "/" || parsed.search || parsed.hash) {
    throw new Error("APP_ORIGIN must be a bare http(s) origin");
  }
  return parsed.origin;
}

export function loadConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  const databasePath = overrides.databasePath ?? process.env.DATABASE_PATH ?? "/var/lib/english-typing-practice/app.db";
  return {
    host: overrides.host ?? process.env.HOST ?? "127.0.0.1",
    port: overrides.port ?? parsePort(process.env.PORT),
    databasePath: path.resolve(databasePath),
    appOrigin: normalizeOrigin(overrides.appOrigin ?? process.env.APP_ORIGIN ?? "https://english-47-120-37-63.sslip.io"),
    logLevel: overrides.logLevel ?? process.env.LOG_LEVEL ?? "info",
    trustProxy: overrides.trustProxy ?? parseTrustProxy(process.env.TRUST_PROXY),
    guestTokenSecret: overrides.guestTokenSecret ?? guestTokenSecret(process.env.GUEST_TOKEN_SECRET),
    ...(overrides.contentSourceDir || process.env.CONTENT_SOURCE_DIR
      ? { contentSourceDir: path.resolve(overrides.contentSourceDir ?? process.env.CONTENT_SOURCE_DIR!) }
      : {})
  };
}

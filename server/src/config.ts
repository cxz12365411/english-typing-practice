import path from "node:path";
import { randomBytes } from "node:crypto";
import { validateEmail } from "./security.js";

export type AppEnvironment = "development" | "test" | "production";

export type EmailDeliveryConfig =
  | { mode: "disabled" }
  | {
      mode: "smtp";
      host: string;
      port: 465;
      username: string;
      password: string;
      fromAddress: string;
      fromName: string;
    }
  | { mode: "test"; outboxFile: string };

export interface AppConfig {
  environment: AppEnvironment;
  host: string;
  port: number;
  databasePath: string;
  appOrigin: string;
  logLevel: string;
  trustProxy: false | "loopback";
  guestTokenSecret: string;
  emailCodeSecret: string;
  emailDelivery: EmailDeliveryConfig;
  emailSelfRegistration: boolean;
  emailDailySendLimit: number;
  emailRegistrationDailySendLimit: number;
  emailRegistrationIpDailyLimit: number;
  contentSourceDir?: string;
}

function parseEnvironment(value: string | undefined): AppEnvironment {
  const normalized = value?.trim().toLowerCase() || "development";
  if (normalized === "development" || normalized === "test" || normalized === "production") return normalized;
  throw new Error("NODE_ENV must be development, test, or production");
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

function applicationSecret(value: string | undefined, name: string): string {
  if (value === undefined) return randomBytes(32).toString("base64url");
  if (Buffer.byteLength(value, "utf8") < 32) throw new Error(`${name} must be at least 32 bytes`);
  return value;
}

function booleanSetting(value: string | undefined, defaultValue: boolean, name: string): boolean {
  if (value === undefined) return defaultValue;
  const normalized = value.trim().toLowerCase();
  if (normalized === "true") return true;
  if (normalized === "false") return false;
  throw new Error(`${name} must be true or false`);
}

function boundedInteger(value: string | undefined, defaultValue: number, name: string, min: number, max: number): number {
  if (value === undefined) return defaultValue;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return parsed;
}

function configuredEmailDelivery(environment: AppEnvironment): EmailDeliveryConfig {
  const mode = process.env.EMAIL_DELIVERY?.trim().toLowerCase() || "disabled";
  if (mode === "disabled") return { mode: "disabled" };
  if (mode === "test") {
    if (environment !== "test") throw new Error("EMAIL_DELIVERY=test is permitted only when NODE_ENV=test");
    const outboxFile = process.env.EMAIL_TEST_OUTBOX_FILE?.trim();
    if (!outboxFile) throw new Error("EMAIL_TEST_OUTBOX_FILE is required when EMAIL_DELIVERY=test");
    return { mode: "test", outboxFile: path.resolve(outboxFile) };
  }
  if (mode !== "smtp") throw new Error("EMAIL_DELIVERY must be disabled, smtp, or test");
  const host = process.env.SMTP_HOST?.trim();
  const username = process.env.SMTP_USERNAME?.trim();
  const password = process.env.SMTP_PASSWORD;
  const fromAddress = process.env.EMAIL_FROM?.trim();
  const fromName = process.env.EMAIL_FROM_NAME?.trim() || "英语打字练习";
  const portValue = process.env.SMTP_PORT?.trim() || "465";
  if (!host || !username || !password || !fromAddress) {
    throw new Error("SMTP_HOST, SMTP_USERNAME, SMTP_PASSWORD, and EMAIL_FROM are required for SMTP delivery");
  }
  if (portValue !== "465") throw new Error("SMTP_PORT must be 465 so verification email always uses implicit TLS");
  if (/[\x00-\x1f\x7f]/.test(fromName)) throw new Error("EMAIL_FROM_NAME must not contain control characters");
  let normalizedFrom: string;
  let normalizedUsername: string;
  try {
    normalizedFrom = validateEmail(fromAddress);
    normalizedUsername = validateEmail(username);
  } catch {
    throw new Error("EMAIL_FROM and SMTP_USERNAME must be plain email addresses");
  }
  if (normalizedFrom !== normalizedUsername) {
    throw new Error("EMAIL_FROM must equal SMTP_USERNAME for authenticated sender delivery");
  }
  return { mode: "smtp", host, port: 465, username, password, fromAddress: normalizedFrom, fromName };
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
  const environment = overrides.environment ?? parseEnvironment(process.env.NODE_ENV);
  const emailDelivery = overrides.emailDelivery ?? configuredEmailDelivery(environment);
  const configuredEmailCodeSecret = overrides.emailCodeSecret ?? process.env.EMAIL_CODE_SECRET;
  if (emailDelivery.mode !== "disabled" && configuredEmailCodeSecret === undefined) {
    throw new Error("EMAIL_CODE_SECRET is required when email delivery is enabled");
  }
  const emailDailySendLimit = overrides.emailDailySendLimit
    ?? boundedInteger(process.env.EMAIL_DAILY_SEND_LIMIT, 180, "EMAIL_DAILY_SEND_LIMIT", 1, 10_000);
  const emailRegistrationDailySendLimit = overrides.emailRegistrationDailySendLimit
    ?? boundedInteger(
      process.env.EMAIL_REGISTRATION_DAILY_SEND_LIMIT,
      Math.min(20, emailDailySendLimit),
      "EMAIL_REGISTRATION_DAILY_SEND_LIMIT",
      1,
      emailDailySendLimit
    );
  const emailRegistrationIpDailyLimit = overrides.emailRegistrationIpDailyLimit
    ?? boundedInteger(
      process.env.EMAIL_REGISTRATION_IP_DAILY_LIMIT,
      Math.min(10, emailRegistrationDailySendLimit),
      "EMAIL_REGISTRATION_IP_DAILY_LIMIT",
      1,
      emailRegistrationDailySendLimit
    );
  if (!Number.isInteger(emailDailySendLimit) || emailDailySendLimit < 1 || emailDailySendLimit > 10_000) {
    throw new Error("EMAIL_DAILY_SEND_LIMIT must be an integer between 1 and 10000");
  }
  if (
    !Number.isInteger(emailRegistrationDailySendLimit) ||
    emailRegistrationDailySendLimit < 1 ||
    emailRegistrationDailySendLimit > emailDailySendLimit
  ) {
    throw new Error("EMAIL_REGISTRATION_DAILY_SEND_LIMIT must be between 1 and EMAIL_DAILY_SEND_LIMIT");
  }
  if (
    !Number.isInteger(emailRegistrationIpDailyLimit) ||
    emailRegistrationIpDailyLimit < 1 ||
    emailRegistrationIpDailyLimit > emailRegistrationDailySendLimit
  ) {
    throw new Error("EMAIL_REGISTRATION_IP_DAILY_LIMIT must be between 1 and EMAIL_REGISTRATION_DAILY_SEND_LIMIT");
  }
  const databasePath = overrides.databasePath ?? process.env.DATABASE_PATH ?? "/var/lib/english-typing-practice/app.db";
  return {
    environment,
    host: overrides.host ?? process.env.HOST ?? "127.0.0.1",
    port: overrides.port ?? parsePort(process.env.PORT),
    databasePath: path.resolve(databasePath),
    appOrigin: normalizeOrigin(overrides.appOrigin ?? process.env.APP_ORIGIN ?? "https://english-47-120-37-63.sslip.io"),
    logLevel: overrides.logLevel ?? process.env.LOG_LEVEL ?? "info",
    trustProxy: overrides.trustProxy ?? parseTrustProxy(process.env.TRUST_PROXY),
    guestTokenSecret: overrides.guestTokenSecret ?? guestTokenSecret(process.env.GUEST_TOKEN_SECRET),
    emailCodeSecret: applicationSecret(configuredEmailCodeSecret, "EMAIL_CODE_SECRET"),
    emailDelivery,
    emailSelfRegistration: overrides.emailSelfRegistration ?? booleanSetting(process.env.EMAIL_SELF_REGISTRATION, false, "EMAIL_SELF_REGISTRATION"),
    emailDailySendLimit,
    emailRegistrationDailySendLimit,
    emailRegistrationIpDailyLimit,
    ...(overrides.contentSourceDir || process.env.CONTENT_SOURCE_DIR
      ? { contentSourceDir: path.resolve(overrides.contentSourceDir ?? process.env.CONTENT_SOURCE_DIR!) }
      : {})
  };
}

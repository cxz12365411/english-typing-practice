import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import argon2 from "argon2";

export const USERNAME_PATTERN = /^[a-z0-9._-]{3,32}$/;
export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 128;
export const EMAIL_MAX_LENGTH = 254;

const ARGON_OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 65_536,
  timeCost: 3,
  parallelism: 1,
  hashLength: 32,
  raw: false
} as const;

export class PasswordWorkQueueFullError extends Error {
  constructor() {
    super("Password hashing queue is full");
    this.name = "PasswordWorkQueueFullError";
  }
}

export class BoundedWorkPool {
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(
    readonly concurrency: number,
    readonly maxQueued: number
  ) {
    if (!Number.isInteger(concurrency) || concurrency < 1 || !Number.isInteger(maxQueued) || maxQueued < 0) {
      throw new Error("Invalid work-pool limits");
    }
  }

  get stats(): { active: number; queued: number } {
    return { active: this.active, queued: this.waiters.length };
  }

  async run<T>(work: () => Promise<T>): Promise<T> {
    if (this.active < this.concurrency && this.waiters.length === 0) {
      this.active += 1;
    } else {
      if (this.waiters.length >= this.maxQueued) throw new PasswordWorkQueueFullError();
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
    try {
      return await work();
    } finally {
      const next = this.waiters.shift();
      if (next) next();
      else this.active -= 1;
    }
  }
}

const passwordWorkPool = new BoundedWorkPool(4, 32);

export function passwordWorkPoolStats(): { active: number; queued: number } {
  return passwordWorkPool.stats;
}

export function normalizeUsername(value: string): string {
  return value.trim().toLowerCase();
}

export function validateUsername(value: unknown): string {
  if (typeof value !== "string") throw new Error("Username must be a string");
  const normalized = normalizeUsername(value);
  if (!USERNAME_PATTERN.test(normalized)) {
    throw new Error("Username must match [a-z0-9._-]{3,32}");
  }
  return normalized;
}

export function validatePassword(value: unknown): string {
  if (typeof value !== "string" || value.length < PASSWORD_MIN_LENGTH || value.length > PASSWORD_MAX_LENGTH) {
    throw new Error(`Password must contain ${PASSWORD_MIN_LENGTH}-${PASSWORD_MAX_LENGTH} characters`);
  }
  return value;
}

export function normalizeEmail(value: string): string {
  return value.normalize("NFKC").trim().toLowerCase();
}

export function validateEmail(value: unknown): string {
  if (typeof value !== "string") throw new Error("Email must be a string");
  const normalized = normalizeEmail(value);
  if (normalized.length < 3 || normalized.length > EMAIL_MAX_LENGTH) throw new Error("Email address is invalid");
  const parts = normalized.split("@");
  if (parts.length !== 2) throw new Error("Email address is invalid");
  const [local, domain] = parts as [string, string];
  if (
    local.length < 1 ||
    local.length > 64 ||
    local.startsWith(".") ||
    local.endsWith(".") ||
    local.includes("..") ||
    !/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+$/i.test(local)
  ) throw new Error("Email address is invalid");
  const labels = domain.split(".");
  if (
    domain.length > 253 ||
    labels.length < 2 ||
    labels.some((label) => label.length < 1 || label.length > 63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(label))
  ) throw new Error("Email address is invalid");
  return normalized;
}

export function generateEmailCode(): string {
  return randomInt(0, 1_000_000).toString().padStart(6, "0");
}

export function emailCodeHash(
  secret: string,
  id: string,
  email: string,
  purpose: string,
  code: string
): string {
  return createHmac("sha256", secret).update(id).update("\0").update(email).update("\0").update(purpose).update("\0").update(code).digest("hex");
}

export function safeHashEqual(actualHex: string, expectedHex: string): boolean {
  const actual = Buffer.from(actualHex, "hex");
  const expected = Buffer.from(expectedHex, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export async function hashPassword(password: string): Promise<string> {
  const validated = validatePassword(password);
  return passwordWorkPool.run(() => argon2.hash(validated, ARGON_OPTIONS));
}

export async function verifyPassword(hash: string, password: string): Promise<boolean> {
  try {
    return await passwordWorkPool.run(() => argon2.verify(hash, password));
  } catch (error) {
    if (error instanceof PasswordWorkQueueFullError) throw error;
    return false;
  }
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function safeTokenEqual(token: string, expectedHash: string): boolean {
  const actual = Buffer.from(tokenHash(token), "hex");
  const expected = Buffer.from(expectedHash, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function temporaryPassword(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%";
  const bytes = randomBytes(20);
  let result = "";
  for (const byte of bytes) result += alphabet[byte % alphabet.length];
  return result;
}

export function normalizeAnswer(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .trim()
    .replace(/\s+/g, " ")
    .toLocaleLowerCase("en-US");
}

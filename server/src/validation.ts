import { badRequest } from "./errors.js";

export function objectBody(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    badRequest("INVALID_BODY", "Request body must be a JSON object");
  }
  return value as Record<string, unknown>;
}

export function stringField(
  body: Record<string, unknown>,
  name: string,
  options: { min?: number; max?: number; optional?: boolean; trim?: boolean } = {}
): string | undefined {
  const value = body[name];
  if (value === undefined && options.optional) return undefined;
  if (typeof value !== "string") badRequest("INVALID_FIELD", `${name} must be a string`, { field: name });
  const result = options.trim === false ? value : value.trim();
  if (options.min !== undefined && result.length < options.min) {
    badRequest("INVALID_FIELD", `${name} is too short`, { field: name, min: options.min });
  }
  if (options.max !== undefined && result.length > options.max) {
    badRequest("INVALID_FIELD", `${name} is too long`, { field: name, max: options.max });
  }
  return result;
}

export function integerField(
  body: Record<string, unknown>,
  name: string,
  options: { min?: number; max?: number; optional?: boolean } = {}
): number | undefined {
  const value = body[name];
  if (value === undefined && options.optional) return undefined;
  if (!Number.isInteger(value)) badRequest("INVALID_FIELD", `${name} must be an integer`, { field: name });
  const number = value as number;
  if (options.min !== undefined && number < options.min) badRequest("INVALID_FIELD", `${name} is too small`, { field: name });
  if (options.max !== undefined && number > options.max) badRequest("INVALID_FIELD", `${name} is too large`, { field: name });
  return number;
}

export function booleanField(body: Record<string, unknown>, name: string, optional = true): boolean | undefined {
  const value = body[name];
  if (value === undefined && optional) return undefined;
  if (typeof value !== "boolean") badRequest("INVALID_FIELD", `${name} must be a boolean`, { field: name });
  return value as boolean;
}

export function enumField<const T extends readonly string[]>(
  body: Record<string, unknown>,
  name: string,
  allowed: T,
  optional = false
): T[number] | undefined {
  const value = body[name];
  if (value === undefined && optional) return undefined;
  if (typeof value !== "string" || !allowed.includes(value)) {
    badRequest("INVALID_FIELD", `${name} must be one of: ${allowed.join(", ")}`, { field: name });
  }
  return value as T[number];
}

export function idParam(params: unknown, name = "id"): string {
  if (!params || typeof params !== "object") badRequest("INVALID_PATH", "Invalid path parameters");
  const value = (params as Record<string, unknown>)[name];
  if (typeof value !== "string" || value.length < 1 || value.length > 100) badRequest("INVALID_PATH", `Invalid ${name}`);
  return value;
}

export function isoOrNow(value: unknown, name: string): number {
  if (value === undefined) return Date.now();
  if (typeof value !== "string") badRequest("INVALID_FIELD", `${name} must be an ISO timestamp`, { field: name });
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) badRequest("INVALID_FIELD", `${name} must be an ISO timestamp`, { field: name });
  const now = Date.now();
  if (timestamp > now + 5 * 60_000 || timestamp < now - 30 * 24 * 60 * 60_000) {
    badRequest("INVALID_FIELD", `${name} is outside the accepted time range`, { field: name });
  }
  return timestamp;
}

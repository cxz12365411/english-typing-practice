export class ApiError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export function badRequest(code: string, message: string, details?: unknown): never {
  throw new ApiError(422, code, message, details);
}

export function conflict(code: string, message: string, details?: unknown): never {
  throw new ApiError(409, code, message, details);
}

export function notFound(message = "Resource not found"): never {
  throw new ApiError(404, "NOT_FOUND", message);
}

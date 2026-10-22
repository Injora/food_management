export const ERROR_CODES = [
  "UNAUTHORIZED",
  "FORBIDDEN",
  "VALIDATION",
  "NOT_FOUND",
  "ALREADY_ISSUED",
  "NOT_ISSUED",
  "QUANTITY_CHANGED",
  "MEMBER_COUNT_LOCKED",
  "CONFLICT",
  "DB_UNAVAILABLE",
  "DB_NOT_CONFIGURED",
  "INTERNAL",
  "NETWORK",
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

/** An expected, user-presentable failure. Anything else is treated as a bug. */
export class AppError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "AppError";
  }
}

export type ActionError = {
  code: ErrorCode;
  message: string;
  details?: Record<string, unknown>;
};

export type ActionResult<T> = { ok: true; data: T } | { ok: false; error: ActionError };

export const HTTP_STATUS: Record<ErrorCode, number> = {
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  VALIDATION: 400,
  NOT_FOUND: 404,
  ALREADY_ISSUED: 409,
  NOT_ISSUED: 409,
  QUANTITY_CHANGED: 409,
  MEMBER_COUNT_LOCKED: 409,
  CONFLICT: 409,
  DB_UNAVAILABLE: 503,
  DB_NOT_CONFIGURED: 503,
  INTERNAL: 500,
  NETWORK: 503,
};

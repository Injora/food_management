import type { z } from "zod";

import { AppError } from "@/lib/errors";

export function parseInput<S extends z.ZodType>(schema: S, raw: unknown): z.infer<S> {
  const result = schema.safeParse(raw);
  if (!result.success) {
    const issue = result.error.issues[0];
    throw new AppError("VALIDATION", issue?.message ?? "Invalid input", {
      issues: result.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    });
  }
  return result.data;
}

type PgLikeError = { code?: string; constraint?: string; message?: string; cause?: unknown };

/** Drizzle wraps driver errors; walk the cause chain to find the pg error. */
export function pgError(err: unknown): PgLikeError | null {
  let cur: unknown = err;
  for (let depth = 0; cur && depth < 5; depth++) {
    const e = cur as PgLikeError;
    if (typeof e.code === "string") return e;
    cur = e.cause;
  }
  return null;
}

export function isUniqueViolation(err: unknown, constraint?: string): boolean {
  const e = pgError(err);
  return e?.code === "23505" && (!constraint || e.constraint === constraint);
}

const CONNECTION_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ENOTFOUND",
  "ETIMEDOUT",
  "EAI_AGAIN",
  "57P01", // admin_shutdown
  "57P03", // cannot_connect_now
  "08000",
  "08001",
  "08003",
  "08006",
  "53300", // too_many_connections
]);

export function isConnectionError(err: unknown): boolean {
  const e = pgError(err);
  if (e?.code && CONNECTION_CODES.has(e.code)) return true;
  let cur: unknown = err;
  for (let depth = 0; cur && depth < 5; depth++) {
    const msg = (cur as PgLikeError).message ?? "";
    if (/Connection terminated|timeout exceeded when trying to connect|connect ECONNREFUSED|getaddrinfo/i.test(msg)) {
      return true;
    }
    cur = (cur as PgLikeError).cause;
  }
  return false;
}

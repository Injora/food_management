import "server-only";

import { unstable_rethrow } from "next/navigation";

import { getDb, type Db } from "@/db";
import { AppError, type ActionResult } from "@/lib/errors";
import { getActor } from "@/server/auth/current";
import type { Actor } from "@/server/auth/permissions";
import { isConnectionError } from "@/server/services/validation";

/** Converts a thrown error into a typed, user-presentable failure. */
export function toActionError(err: unknown): Extract<ActionResult<never>, { ok: false }> {
  if (err instanceof AppError) {
    return { ok: false, error: { code: err.code, message: err.message, details: err.details } };
  }
  if (isConnectionError(err)) {
    console.error("[db] connection failure", err);
    return {
      ok: false,
      error: { code: "DB_UNAVAILABLE", message: "Can't reach the database right now. Nothing was saved; please try again." },
    };
  }
  console.error("[action] unexpected error", err);
  return {
    ok: false,
    error: { code: "INTERNAL", message: "Something went wrong on the server and the change was not saved. Please try again." },
  };
}

/**
 * Wraps a service call for a Server Action or Route Handler: resolves the
 * session, runs the service (which authorizes), and never reports success
 * unless the service — and its transaction — completed.
 */
export async function runAction<T>(fn: (db: Db, actor: Actor | null) => Promise<T>): Promise<ActionResult<T>> {
  try {
    const db = getDb();
    const actor = await getActor();
    return { ok: true, data: await fn(db, actor) };
  } catch (err) {
    unstable_rethrow(err);
    return toActionError(err);
  }
}

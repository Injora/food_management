import { and, count, eq, gt, lt } from "drizzle-orm";

import type { Db } from "@/db";
import { loginAttempts } from "@/db/schema";

/** Failed sign-ins allowed per window before that email, or that client, is locked out. */
export const MAX_FAILURES_PER_EMAIL = 8;
export const MAX_FAILURES_PER_IP = 30;
export const LOCKOUT_WINDOW_MS = 15 * 60 * 1000;

export async function isLockedOut(db: Db, email: string, ip: string): Promise<boolean> {
  const since = new Date(Date.now() - LOCKOUT_WINDOW_MS);
  const [[byEmail], [byIp]] = await Promise.all([
    db.select({ n: count() }).from(loginAttempts).where(and(eq(loginAttempts.email, email), gt(loginAttempts.attemptedAt, since))),
    db.select({ n: count() }).from(loginAttempts).where(and(eq(loginAttempts.ip, ip), gt(loginAttempts.attemptedAt, since))),
  ]);
  return byEmail.n >= MAX_FAILURES_PER_EMAIL || byIp.n >= MAX_FAILURES_PER_IP;
}

export async function recordFailure(db: Db, email: string, ip: string) {
  await db.insert(loginAttempts).values({ email, ip });
  // Opportunistic cleanup keeps the table small without a cron job.
  await db.delete(loginAttempts).where(lt(loginAttempts.attemptedAt, new Date(Date.now() - 24 * 60 * 60 * 1000)));
}

export async function clearFailures(db: Db, email: string) {
  await db.delete(loginAttempts).where(eq(loginAttempts.email, email));
}

import { createHash, randomBytes } from "node:crypto";
import { and, eq, gt, lt } from "drizzle-orm";

import type { Db } from "@/db";
import { sessions, users } from "@/db/schema";
import { hashPassword, verifyPassword } from "./password";
import type { Actor } from "./permissions";

import type { Role } from "@/lib/domain";

export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** Judges' sessions are short: they can see and change every team's marks. */
export const SUPERADMIN_SESSION_TTL_MS = 12 * 60 * 60 * 1000;

const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

export async function createSession(db: Db, userId: string, role?: Role) {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + (role === "superadmin" ? SUPERADMIN_SESSION_TTL_MS : SESSION_TTL_MS));
  await db.insert(sessions).values({ userId, tokenHash: hashToken(token), expiresAt });
  // Opportunistic cleanup keeps the table small without a cron job.
  await db.delete(sessions).where(lt(sessions.expiresAt, new Date()));
  return { token, expiresAt };
}

export async function validateSessionToken(db: Db, token: string | undefined | null): Promise<Actor | null> {
  if (!token || token.length > 100) return null;
  const [row] = await db
    .select({ id: users.id, email: users.email, name: users.name, role: users.role })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(and(eq(sessions.tokenHash, hashToken(token)), gt(sessions.expiresAt, new Date()), eq(users.active, true)))
    .limit(1);
  return row ?? null;
}

export async function deleteSession(db: Db, token: string) {
  await db.delete(sessions).where(eq(sessions.tokenHash, hashToken(token)));
}

export async function deleteUserSessions(db: Db, userId: string) {
  await db.delete(sessions).where(eq(sessions.userId, userId));
}

// Verifying against a real hash when the user doesn't exist keeps response
// times similar, so email addresses can't be probed by timing.
let dummyHash: Promise<string> | undefined;

export async function authenticate(db: Db, email: string, password: string): Promise<Actor | null> {
  const [user] = await db
    .select()
    .from(users)
    .where(eq(users.email, email.trim().toLowerCase()))
    .limit(1);
  if (!user) {
    dummyHash ??= hashPassword("not-a-real-password");
    await verifyPassword(password, await dummyHash);
    return null;
  }
  const ok = await verifyPassword(password, user.passwordHash);
  if (!ok || !user.active) return null;
  return { id: user.id, email: user.email, name: user.name, role: user.role };
}

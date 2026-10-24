import { and, asc, count, eq, ne, sql } from "drizzle-orm";
import { z } from "zod";

import type { Db } from "@/db";
import { users } from "@/db/schema";
import { AppError } from "@/lib/errors";
import { ROLES } from "@/lib/domain";
import { hashPassword, MIN_PASSWORD_LENGTH } from "@/server/auth/password";
import { assertPermission, type Actor } from "@/server/auth/permissions";
import { deleteUserSessions } from "@/server/auth/session";
import { writeAudit } from "./audit";
import { isUniqueViolation, parseInput } from "./validation";

export type UserRow = { id: string; email: string; name: string; role: (typeof ROLES)[number]; active: boolean; createdAt: string };

export async function listUsers(db: Db, actor: Actor | null): Promise<UserRow[]> {
  assertPermission(actor, "users:manage");
  const rows = await db
    .select({ id: users.id, email: users.email, name: users.name, role: users.role, active: users.active, createdAt: users.createdAt })
    .from(users)
    .orderBy(asc(users.role), asc(users.name));
  return rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() }));
}

const passwordSchema = z
  .string()
  .min(MIN_PASSWORD_LENGTH, `Password must be at least ${MIN_PASSWORD_LENGTH} characters`)
  .max(200);

const createUserSchema = z.object({
  email: z.email("Enter a valid email").trim().toLowerCase(),
  name: z.string().trim().min(1, "Name is required").max(120),
  role: z.enum(ROLES),
  password: passwordSchema,
});

export async function createUser(db: Db, actor: Actor | null, raw: unknown) {
  assertPermission(actor, "users:manage");
  const input = parseInput(createUserSchema, raw);
  try {
    return await db.transaction(async (tx) => {
      const [user] = await tx
        .insert(users)
        .values({ email: input.email, name: input.name, role: input.role, passwordHash: await hashPassword(input.password) })
        .returning({ id: users.id });
      await writeAudit(tx, actor, { action: "user_create", after: { email: input.email, name: input.name, role: input.role } });
      return user;
    });
  } catch (err) {
    if (isUniqueViolation(err, "users_email_unique")) throw new AppError("CONFLICT", "A user with that email already exists.");
    throw err;
  }
}

const updateUserSchema = z.object({
  userId: z.uuid(),
  name: z.string().trim().min(1).max(120).optional(),
  role: z.enum(ROLES).optional(),
  active: z.boolean().optional(),
  password: passwordSchema.optional(),
});

export async function updateUser(db: Db, actor: Actor | null, raw: unknown) {
  assertPermission(actor, "users:manage");
  const input = parseInput(updateUserSchema, raw);

  const result = await db.transaction(async (tx) => {
    // Serialise admin changes so two admins can't demote each other at once.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('food-management:users'))`);
    const [user] = await tx.select().from(users).where(eq(users.id, input.userId));
    if (!user) throw new AppError("NOT_FOUND", "User not found.");

    const losingAdmin = user.role === "admin" && user.active && (input.role === "organizer" || input.active === false);
    if (losingAdmin) {
      if (user.id === actor.id) throw new AppError("CONFLICT", "You can't remove your own admin access.");
      const [{ admins }] = await tx
        .select({ admins: count() })
        .from(users)
        .where(and(eq(users.role, "admin"), eq(users.active, true), ne(users.id, user.id)));
      if (admins === 0) throw new AppError("CONFLICT", "At least one active admin is required.");
    }

    const before: Record<string, unknown> = {};
    const after: Record<string, unknown> = {};
    const set: Partial<typeof users.$inferInsert> = {};
    if (input.name !== undefined && input.name !== user.name) {
      before.name = user.name;
      after.name = set.name = input.name;
    }
    if (input.role !== undefined && input.role !== user.role) {
      before.role = user.role;
      after.role = set.role = input.role;
    }
    if (input.active !== undefined && input.active !== user.active) {
      before.active = user.active;
      after.active = set.active = input.active;
    }
    if (input.password) {
      set.passwordHash = await hashPassword(input.password);
      after.password = "reset";
    }
    if (Object.keys(set).length === 0) return { userId: user.id, changed: false, revokeSessions: false };

    await tx.update(users).set({ ...set, updatedAt: sql`now()` }).where(eq(users.id, user.id));
    await writeAudit(tx, actor, { action: "user_update", details: { email: user.email }, before, after });
    return { userId: user.id, changed: true, revokeSessions: set.active === false || !!set.passwordHash || set.role !== undefined };
  });

  if (result.revokeSessions) await deleteUserSessions(db, result.userId);
  return { userId: result.userId, changed: result.changed };
}

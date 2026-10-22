/**
 * Creates or updates a user from the command line.
 *   pnpm user:create --email a@b.c --name "Asha" --role organizer --password '...'
 * With no flags it uses ADMIN_EMAIL / ADMIN_PASSWORD / ADMIN_NAME as an admin.
 */
import { parseArgs } from "node:util";
import { eq, sql } from "drizzle-orm";

import { createDb } from "../src/db";
import { users } from "../src/db/schema";
import { hashPassword, MIN_PASSWORD_LENGTH } from "../src/server/auth/password";
import { requireEnv } from "./env";

const { values } = parseArgs({
  options: {
    email: { type: "string" },
    name: { type: "string" },
    role: { type: "string", default: "admin" },
    password: { type: "string" },
  },
});

const email = (values.email ?? requireEnv("ADMIN_EMAIL")).trim().toLowerCase();
const password = values.password ?? requireEnv("ADMIN_PASSWORD");
const name = values.name ?? process.env.ADMIN_NAME ?? "Admin";
const role = values.role === "organizer" ? "organizer" : "admin";

if (password.length < MIN_PASSWORD_LENGTH) {
  console.error(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
  process.exit(1);
}

const { db, pool } = createDb(requireEnv("DATABASE_URL"), 1);
try {
  const passwordHash = await hashPassword(password);
  const [existing] = await db.select({ id: users.id }).from(users).where(eq(users.email, email));
  if (existing) {
    await db.update(users).set({ name, role, passwordHash, active: true, updatedAt: sql`now()` }).where(eq(users.id, existing.id));
    console.log(`Updated ${role} ${email}.`);
  } else {
    await db.insert(users).values({ email, name, role, passwordHash });
    console.log(`Created ${role} ${email}.`);
  }
} finally {
  await pool.end();
}

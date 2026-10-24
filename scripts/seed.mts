/**
 * pnpm db:seed    ensure the admin from ADMIN_EMAIL / ADMIN_PASSWORD exists.
 * Registrations are never seeded: import the real file at /import.
 */
import { eq } from "drizzle-orm";

import { createDb } from "../src/db";
import { users } from "../src/db/schema";
import { hashPassword, MIN_PASSWORD_LENGTH } from "../src/server/auth/password";
import { requireEnv } from "./env";

const { db, pool } = createDb(requireEnv("DATABASE_URL"), 1);

try {
  const email = requireEnv("ADMIN_EMAIL").toLowerCase();
  const password = requireEnv("ADMIN_PASSWORD");
  if (password.length < MIN_PASSWORD_LENGTH) throw new Error(`ADMIN_PASSWORD must be at least ${MIN_PASSWORD_LENGTH} characters`);
  const [existing] = await db.select().from(users).where(eq(users.email, email));
  if (existing) {
    console.log(`User ${email} already exists (left unchanged).`);
  } else {
    await db.insert(users).values({ email, name: process.env.ADMIN_NAME || "Event Admin", role: "admin", passwordHash: await hashPassword(password) });
    console.log(`Created admin ${email}.`);
  }
} catch (err) {
  console.error("Seed failed:", err);
  process.exitCode = 1;
} finally {
  await pool.end();
}

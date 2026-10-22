/**
 * pnpm db:seed           ensure the admin from ADMIN_EMAIL / ADMIN_PASSWORD exists
 * pnpm db:seed:sample    also add a demo organizer and the teams in samples/teams-sample.csv
 */
import fs from "node:fs";
import { eq } from "drizzle-orm";
import Papa from "papaparse";

import { createDb } from "../src/db";
import { users } from "../src/db/schema";
import { detectImportSetup } from "../src/lib/csv-import";
import { hashPassword, MIN_PASSWORD_LENGTH } from "../src/server/auth/password";
import { commitImport } from "../src/server/services/import";
import { requireEnv } from "./env";

const withSample = process.argv.includes("--sample");
const { db, pool } = createDb(requireEnv("DATABASE_URL"), 1);

async function ensureUser(email: string, name: string, role: "admin" | "organizer", password: string) {
  const [existing] = await db.select().from(users).where(eq(users.email, email));
  if (existing) {
    console.log(`User ${email} already exists (left unchanged).`);
    return { id: existing.id, email, name: existing.name, role: existing.role };
  }
  const [created] = await db
    .insert(users)
    .values({ email, name, role, passwordHash: await hashPassword(password) })
    .returning();
  console.log(`Created ${role} ${email}.`);
  return { id: created.id, email, name, role };
}

try {
  const adminPassword = requireEnv("ADMIN_PASSWORD");
  if (adminPassword.length < MIN_PASSWORD_LENGTH) throw new Error(`ADMIN_PASSWORD must be at least ${MIN_PASSWORD_LENGTH} characters`);
  const admin = await ensureUser(requireEnv("ADMIN_EMAIL").toLowerCase(), process.env.ADMIN_NAME || "Event Admin", "admin", adminPassword);

  if (withSample) {
    await ensureUser("organizer@example.com", "Demo Organizer", "organizer", "organizer-password");
    const text = fs.readFileSync("samples/teams-sample.csv", "utf8");
    const [headers, ...rows] = Papa.parse<string[]>(text, { skipEmptyLines: "greedy" }).data;
    const table = { headers, rows };
    const report = await commitImport(db, admin, {
      fileName: "samples/teams-sample.csv",
      table,
      options: detectImportSetup(table),
      mode: "add_only",
    });
    const s = report.summary;
    console.log(`Sample teams: ${s.create} created, ${s.skipExisting} already present, ${s.invalidRows + s.duplicates} rejected.`);
  }
} catch (err) {
  console.error("Seed failed:", err);
  process.exitCode = 1;
} finally {
  await pool.end();
}

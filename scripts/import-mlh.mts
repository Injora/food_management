/**
 * Loads the MLH portal's registration export into the MLH registrations page,
 * replacing the previous list. Touches nothing else.
 *   pnpm import:mlh path/to/export.csv
 */
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { eq } from "drizzle-orm";

import { createDb } from "../src/db";
import { users } from "../src/db/schema";
import { parseMlhRows } from "../src/lib/mlh";
import { readRegistrationFile } from "../src/lib/registration-file";
import { replaceMlhList } from "../src/server/services/mlh";
import { requireEnv } from "./env";

const file = process.argv[2];
if (!file) {
  console.error("Usage: pnpm import:mlh <export.csv|.xlsx>");
  process.exit(1);
}
const [sheet] = await readRegistrationFile(file, readFileSync(file));
const rows = parseMlhRows(sheet.rows);

const { db, pool } = createDb(requireEnv("DATABASE_URL"), 1);
try {
  const [admin] = await db.select().from(users).where(eq(users.email, requireEnv("ADMIN_EMAIL").trim().toLowerCase()));
  if (!admin) throw new Error("ADMIN_EMAIL user not found");
  const result = await replaceMlhList(db, { id: admin.id, email: admin.email, name: admin.name, role: admin.role }, { fileName: basename(file), rows });
  console.log(`Loaded ${result.rows} MLH registrations:`, result.statuses);
} finally {
  await pool.end();
}

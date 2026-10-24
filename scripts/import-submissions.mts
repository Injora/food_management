/**
 * Loads the problem-statement form responses for the judging panel, replacing
 * the previous ones. Touches nothing else. Runs as a super admin.
 *   pnpm import:submissions path/to/Hackday_PS_Matching.xlsx [--as superadmin@email]
 */
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { parseArgs } from "node:util";
import { and, eq } from "drizzle-orm";

import { createDb } from "../src/db";
import { users } from "../src/db/schema";
import { readRegistrationFile } from "../src/lib/registration-file";
import { parseSubmissionRows } from "../src/lib/submissions";
import { replaceSubmissions } from "../src/server/services/submissions";
import { requireEnv } from "./env";

const { values, positionals } = parseArgs({ allowPositionals: true, options: { as: { type: "string", default: "injoraman@gmail.com" } } });
const file = positionals[0];
if (!file) {
  console.error("Usage: pnpm import:submissions <file.xlsx|.csv> [--as superadmin@email]");
  process.exit(1);
}
const sheets = await readRegistrationFile(file, readFileSync(file));
const sheet = sheets.find((s) => s.name.toLowerCase() === "submissions") ?? sheets[0];
const rows = parseSubmissionRows(sheet.rows);

const { db, pool } = createDb(requireEnv("DATABASE_URL"), 1);
try {
  const [u] = await db.select().from(users).where(and(eq(users.email, values.as!.toLowerCase()), eq(users.active, true)));
  if (!u) throw new Error(`No active user ${values.as}`);
  const result = await replaceSubmissions(db, { id: u.id, email: u.email, name: u.name, role: u.role }, { fileName: basename(file), rows });
  console.log(`Loaded ${result.rows} responses from "${sheet.name}", linked to ${result.matchedTeams} teams.`);
  if (result.unmatched.length) console.log(`No team found for ${result.unmatched.length}: ${result.unmatched.join("; ")}`);
} finally {
  await pool.end();
}

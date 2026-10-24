/**
 * Imports registration files through the same validated, transactional
 * service as the Registration import page.
 *   pnpm import:registrations "file.csv" [more files…]            dry run (default)
 *   pnpm import:registrations "file.csv" --commit [--update]       write
 * Runs as the admin in ADMIN_EMAIL. Files are imported in the order given.
 */
import fs from "node:fs";
import { eq } from "drizzle-orm";

import { createDb } from "../src/db";
import { users } from "../src/db/schema";
import { readRegistrationFile } from "../src/lib/registration-file";
import { detectMapping, mappingBaseSchema, prepareTable } from "../src/lib/registration-import";
import { analyzeImport, commitImport, type ImportRequest } from "../src/server/services/import";
import { requireEnv } from "./env";

const args = process.argv.slice(2);
const commit = args.includes("--commit");
const mode = args.includes("--update") ? "update_existing" : "add_only";
const files = args.filter((a) => !a.startsWith("--"));
if (files.length === 0) {
  console.error('Usage: pnpm import:registrations <file.csv|file.xlsx> [...] [--commit] [--update]');
  process.exit(1);
}

const { db, pool } = createDb(requireEnv("DATABASE_URL"), 2);
try {
  const email = requireEnv("ADMIN_EMAIL").toLowerCase();
  const [admin] = await db.select().from(users).where(eq(users.email, email));
  if (!admin || admin.role !== "admin") throw new Error(`Admin ${email} not found. Run pnpm db:seed first.`);
  const actor = { id: admin.id, email: admin.email, name: admin.name, role: admin.role };

  for (const file of files) {
    for (const sheet of await readRegistrationFile(file, new Uint8Array(fs.readFileSync(file)))) {
      const table = prepareTable(sheet.rows);
      const request: ImportRequest = {
        fileName: file,
        sheetName: sheet.name === file ? null : sheet.name,
        headerRow: table.headerRow,
        raw: sheet.rows,
        mapping: mappingBaseSchema.parse(detectMapping(table)),
        mode,
      };
      const result = commit ? await commitImport(db, actor, request) : await analyzeImport(db, actor, request);
      const s = result.summary;
      console.log(`\n=== ${file}${request.sheetName ? ` [${request.sheetName}]` : ""} — ${commit ? "IMPORTED" : "dry run"}`);
      console.log(
        `teams in file ${s.teamsInFile}, participants ${s.participantsInFile} | new ${s.create}, update ${s.update}, unchanged ${s.unchanged}, existing-differs ${s.skipExisting}, blocked ${s.blocked} | participants added ${s.participantsToCreate}, updated ${s.participantsToUpdate}`,
      );
      for (const i of result.issues.filter((x) => x.severity !== "info")) {
        console.log(`  ${i.severity.toUpperCase()} [rows ${i.rowNumbers.join(", ")}] ${i.team ?? ""}: ${i.message}`);
      }
      for (const t of result.teams.filter((x) => x.action === "blocked")) console.log(`  BLOCKED ${t.teamName}: ${t.blockReason}`);
    }
  }
  if (!commit) console.log("\nDry run only. Re-run with --commit to import.");
} catch (err) {
  console.error("Import failed (nothing was written for the failing file):", err instanceof Error ? err.message : err);
  process.exitCode = 1;
} finally {
  await pool.end();
}

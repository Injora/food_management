/**
 * Dry run of the registration importer on local files (no database access):
 *   pnpm import:check "Hack Day Team - Sheet11.csv" [more files…] [--verbose]
 * Prints the detected layout and mapping, team/participant counts and every
 * validation issue, exactly as the import screen would show them.
 */
import fs from "node:fs";

import { readRegistrationFile } from "../src/lib/registration-file";
import { buildTeams, detectMapping, mappingSchema, prepareTable } from "../src/lib/registration-import";

const verbose = process.argv.includes("--verbose");
const files = process.argv.slice(2).filter((a) => !a.startsWith("--"));
if (files.length === 0) {
  console.error('Usage: pnpm import:check <file.csv|file.xlsx> [...] [--verbose]');
  process.exit(1);
}

for (const file of files) {
  for (const sheet of await readRegistrationFile(file, new Uint8Array(fs.readFileSync(file)))) {
  const table = prepareTable(sheet.rows);
  const mapping = mappingSchema.parse(detectMapping(table));
  const result = buildTeams(table, mapping);
  const col = (i: number | null) => (i === null ? "—" : `${i + 1}:${table.headers[i]}`);

  console.log(`\n=== ${file}${sheet.name !== file ? ` [${sheet.name}]` : ""}`);
  console.log(`header row: ${table.headerRow === null ? "none (columns inferred from contents)" : table.headerRow + 1}; skipped preamble rows: ${table.skippedRows.join(", ") || "none"}`);
  console.log(`layout: ${mapping.layout}; team name ${col(mapping.teamName)}; college ${col(mapping.college)}; size ${col(mapping.declaredSize)}; registered ${col(mapping.declaredRegistered)}`);
  console.log(`leader: name ${col(mapping.leader.name)}, email ${col(mapping.leader.email)}, phone ${col(mapping.leader.phone)}`);
  mapping.members.forEach((s, i) => console.log(`member slot ${i + 2}: name ${col(s.name)}, email ${col(s.email)}, phone ${col(s.phone)}`));
  const participants = result.teams.reduce((s, t) => s + t.members.length, 0);
  console.log(`rows: ${result.totalRows} (${result.blankRows} blank, ${result.excludedRows} excluded) -> teams: ${result.teams.length}, participants: ${participants}`);
  for (const sev of ["error", "warning", "info"] as const) {
    const list = result.issues.filter((i) => i.severity === sev);
    if (list.length === 0) continue;
    console.log(`${sev}s (${list.length}):`);
    for (const i of list) console.log(`  [rows ${i.rowNumbers.join(", ")}] ${i.team ?? ""}: ${i.message}`);
  }
  if (verbose) {
    for (const t of result.teams) {
      console.log(`  ${t.teamName} (${t.members.length}) — ${t.members.map((m) => `${m.isLeader ? "*" : ""}${m.name}`).join(", ")}`);
    }
  }
}
}

import { eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";

import type { Db, Executor, Tx } from "@/db";
import { distributions, teams } from "@/db/schema";
import {
  buildTeamsFromTable,
  importOptionsSchema,
  parsedTableSchema,
  type BuildResult,
  type CandidateTeam,
  type RejectedTeam,
  type RowIssue,
} from "@/lib/csv-import";
import { AppError } from "@/lib/errors";
import { assertPermission, type Actor } from "@/server/auth/permissions";
import { writeAudit } from "./audit";
import { insertTeamsWithMeals } from "./teams";
import { parseInput } from "./validation";

export const IMPORT_MODES = ["add_only", "update_existing"] as const;
export type ImportMode = (typeof IMPORT_MODES)[number];

export const importRequestSchema = z.object({
  fileName: z.string().trim().max(255).default("upload.csv"),
  table: parsedTableSchema,
  options: importOptionsSchema,
  mode: z.enum(IMPORT_MODES),
  /** Team keys the organizer unticked during review. */
  skipKeys: z.array(z.string()).max(50_000).default([]),
});
export type ImportRequest = z.input<typeof importRequestSchema>;

export type FieldChange = { field: "teamName" | "teamCode" | "leaderName" | "leaderEmail" | "memberCount"; from: unknown; to: unknown };

export type TeamAction =
  | "create" // new team
  | "update" // existing, unissued, fields differ (update mode)
  | "unchanged" // existing, identical
  | "skip_existing" // existing, add-only mode
  | "blocked" // can't be applied safely
  | "deselected"; // unticked by the organizer

export type AnalyzedTeam = CandidateTeam & {
  action: TeamAction;
  existingTeamId: string | null;
  changes: FieldChange[];
  blockReason: string | null;
};

export type ImportSummary = {
  totalRows: number;
  blankRows: number;
  excludedRows: number;
  invalidRows: number;
  teamsInFile: number;
  create: number;
  update: number;
  unchanged: number;
  skipExisting: number;
  blocked: number;
  deselected: number;
  duplicates: number;
  invalidTeams: number;
  withWarnings: number;
  membersToCreate: number;
};

export type ImportAnalysis = {
  mode: ImportMode;
  summary: ImportSummary;
  teams: AnalyzedTeam[];
  invalidRows: RowIssue[];
  rejected: RejectedTeam[];
};

export type ImportReport = ImportAnalysis & { committedAt: string };

type ExistingTeam = {
  id: string;
  teamName: string;
  teamNameKey: string;
  teamCode: string;
  teamLeaderName: string | null;
  teamLeaderEmail: string | null;
  memberCount: number;
  issuedMeals: number;
};

async function loadExisting(exec: Executor): Promise<ExistingTeam[]> {
  const [rows, issued] = await Promise.all([
    exec
      .select({
        id: teams.id,
        teamName: teams.teamName,
        teamNameKey: teams.teamNameKey,
        teamCode: teams.teamCode,
        teamLeaderName: teams.teamLeaderName,
        teamLeaderEmail: teams.teamLeaderEmail,
        memberCount: teams.memberCount,
      })
      .from(teams),
    exec
      .select({ teamId: distributions.teamId, n: sql<number>`count(*)::int` })
      .from(distributions)
      .where(eq(distributions.status, "issued"))
      .groupBy(distributions.teamId),
  ]);
  const issuedByTeam = new Map(issued.map((r) => [r.teamId, r.n]));
  return rows.map((r) => ({ ...r, issuedMeals: issuedByTeam.get(r.id) ?? 0 }));
}

function analyze(build: BuildResult, existing: ExistingTeam[], mode: ImportMode, skipKeys: Set<string>): ImportAnalysis {
  const byCode = new Map(existing.map((t) => [t.teamCode, t]));
  const byKey = new Map(existing.map((t) => [t.teamNameKey, t]));
  const takenCodes = new Set(existing.map((t) => t.teamCode));

  const analyzed: AnalyzedTeam[] = build.teams.map((c) => {
    const team: AnalyzedTeam = { ...c, warnings: [...c.warnings], action: "create", existingTeamId: null, changes: [], blockReason: null };

    const codeMatch = c.codeSource === "csv" ? byCode.get(c.teamCode) : undefined;
    const nameMatch = byKey.get(c.teamNameKey);
    if (codeMatch && nameMatch && codeMatch.id !== nameMatch.id) {
      team.action = "blocked";
      team.blockReason = `Code ${c.teamCode} belongs to "${codeMatch.teamName}" but the name matches "${nameMatch.teamName}" (${nameMatch.teamCode})`;
      return team;
    }
    const match = codeMatch ?? nameMatch;

    if (!match) {
      // New team. Derived codes must not collide with any existing code.
      if (c.codeSource === "derived") {
        const base = c.teamCode;
        let n = 2;
        while (takenCodes.has(team.teamCode)) team.teamCode = `${base}-${n++}`;
      } else if (takenCodes.has(c.teamCode)) {
        team.action = "blocked";
        team.blockReason = `Team code ${c.teamCode} is already used by another team`;
        return team;
      }
      takenCodes.add(team.teamCode);
      return team;
    }

    team.existingTeamId = match.id;
    const changes: FieldChange[] = [];
    const diff = (field: FieldChange["field"], from: unknown, to: unknown) => {
      // Blank or unmapped cells never erase existing data.
      if (to != null && to !== from) changes.push({ field, from, to });
    };
    diff("teamName", match.teamName, c.teamName);
    // Codes we derived ourselves never replace an existing code.
    diff("teamCode", match.teamCode, c.codeSource === "csv" ? c.teamCode : null);
    diff("leaderName", match.teamLeaderName, c.leaderName);
    diff("leaderEmail", match.teamLeaderEmail, c.leaderEmail);
    diff("memberCount", match.memberCount, c.memberCount);
    team.changes = changes;
    team.teamCode = match.teamCode;

    if (mode === "add_only") {
      team.action = "skip_existing";
    } else if (changes.length === 0) {
      team.action = "unchanged";
    } else if (match.issuedMeals > 0) {
      team.action = "blocked";
      team.blockReason = `Coupons already issued for ${match.issuedMeals} meal(s); member count and details can only be changed through an admin correction`;
    } else {
      const codeChange = changes.find((ch) => ch.field === "teamCode");
      if (codeChange && takenCodes.has(codeChange.to as string)) {
        team.action = "blocked";
        team.blockReason = `Team code ${codeChange.to as string} is already used by another team`;
      } else {
        team.action = "update";
        if (codeChange) team.teamCode = codeChange.to as string;
      }
    }
    return team;
  });

  for (const t of analyzed) {
    if (skipKeys.has(t.key) && (t.action === "create" || t.action === "update")) t.action = "deselected";
  }

  const countOf = (a: TeamAction) => analyzed.filter((t) => t.action === a).length;
  return {
    mode,
    teams: analyzed,
    invalidRows: build.invalidRows,
    rejected: build.rejected,
    summary: {
      totalRows: build.totalRows,
      blankRows: build.blankRows,
      excludedRows: build.excludedRows,
      invalidRows: build.invalidRows.length,
      teamsInFile: analyzed.length,
      create: countOf("create"),
      update: countOf("update"),
      unchanged: countOf("unchanged"),
      skipExisting: countOf("skip_existing"),
      blocked: countOf("blocked"),
      deselected: countOf("deselected"),
      duplicates: build.rejected.filter((r) => r.kind === "duplicate").length,
      invalidTeams: build.rejected.filter((r) => r.kind === "invalid").length,
      withWarnings: analyzed.filter((t) => t.warnings.length > 0).length,
      membersToCreate: analyzed.filter((t) => t.action === "create").reduce((s, t) => s + t.memberCount, 0),
    },
  };
}

function build(request: z.infer<typeof importRequestSchema>): BuildResult {
  if (request.table.rows.length === 0) {
    throw new AppError("VALIDATION", "The file has a header row but no data rows.");
  }
  try {
    return buildTeamsFromTable(request.table, request.options);
  } catch (err) {
    throw new AppError("VALIDATION", err instanceof Error ? err.message : "Could not read the file with this column mapping.");
  }
}

/** Dry run: what the import would do right now. Changes nothing. */
export async function analyzeImport(db: Db, actor: Actor | null, raw: unknown): Promise<ImportAnalysis> {
  assertPermission(actor, "teams:import");
  const request = parseInput(importRequestSchema, raw);
  const result = build(request);
  return analyze(result, await loadExisting(db), request.mode, new Set(request.skipKeys));
}

/**
 * Applies the import atomically. The analysis is recomputed inside the
 * transaction (under a lock that serialises imports), so the client's preview
 * is never trusted and a meal issued after the preview still blocks updates.
 */
export async function commitImport(db: Db, actor: Actor | null, raw: unknown): Promise<ImportReport> {
  assertPermission(actor, "teams:import");
  const request = parseInput(importRequestSchema, raw);
  const result = build(request);

  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('food-management:csv-import'))`);
    const analysis = analyze(result, await loadExisting(tx), request.mode, new Set(request.skipKeys));

    const toCreate = analysis.teams.filter((t) => t.action === "create");
    const created = await insertTeamsWithMeals(
      tx,
      toCreate.map((t) => ({
        teamName: t.teamName,
        teamNameKey: t.teamNameKey,
        teamCode: t.teamCode,
        teamLeaderName: t.leaderName,
        teamLeaderEmail: t.leaderEmail,
        memberCount: t.memberCount,
      })),
    );
    created.forEach((row, i) => (toCreate[i].existingTeamId = row.id));

    await applyUpdates(tx, analysis.teams.filter((t) => t.action === "update"));

    analysis.summary.create = analysis.teams.filter((t) => t.action === "create").length;
    analysis.summary.update = analysis.teams.filter((t) => t.action === "update").length;
    analysis.summary.blocked = analysis.teams.filter((t) => t.action === "blocked").length;

    const updated = analysis.teams.filter((t) => t.action === "update");
    await writeAudit(tx, actor, [
      {
        action: "csv_import",
        details: {
          fileName: request.fileName,
          mode: request.mode,
          summary: analysis.summary,
          createdCodes: toCreate.map((t) => t.teamCode),
          updatedCodes: updated.map((t) => t.teamCode),
        },
      },
      ...updated.map((t) => ({
        action: "team_update" as const,
        teamId: t.existingTeamId!,
        teamLabel: `${t.teamName} (${t.teamCode})`,
        reason: `CSV import: ${request.fileName}`,
        before: Object.fromEntries(t.changes.map((c) => [c.field, c.from])),
        after: Object.fromEntries(t.changes.map((c) => [c.field, c.to])),
      })),
    ]);

    return { ...analysis, committedAt: new Date().toISOString() };
  });
}

async function applyUpdates(tx: Tx, updates: AnalyzedTeam[]) {
  if (updates.length === 0) return;
  const ids = updates.map((t) => t.existingTeamId!);
  // Lock the meal rows first: an issuance that committed after the analysis
  // read is now visible, and new issuances wait until this import commits.
  const locked = await tx
    .select({ teamId: distributions.teamId, status: distributions.status })
    .from(distributions)
    .where(inArray(distributions.teamId, ids))
    .for("update");
  const issued = new Set(locked.filter((d) => d.status === "issued").map((d) => d.teamId));

  for (const t of updates) {
    if (issued.has(t.existingTeamId!)) {
      t.action = "blocked";
      t.blockReason = "A meal was issued to this team while the import was running";
      continue;
    }
    const set: Partial<typeof teams.$inferInsert> = {};
    for (const c of t.changes) {
      if (c.field === "teamName") {
        set.teamName = c.to as string;
        set.teamNameKey = t.teamNameKey;
      } else if (c.field === "teamCode") set.teamCode = c.to as string;
      else if (c.field === "leaderName") set.teamLeaderName = c.to as string;
      else if (c.field === "leaderEmail") set.teamLeaderEmail = c.to as string;
      else if (c.field === "memberCount") set.memberCount = c.to as number;
    }
    await tx.update(teams).set({ ...set, updatedAt: sql`now()` }).where(eq(teams.id, t.existingTeamId!));
    if (set.memberCount !== undefined) {
      await tx
        .update(distributions)
        .set({ couponQuantity: set.memberCount, updatedAt: sql`now()` })
        .where(eq(distributions.teamId, t.existingTeamId!));
    }
  }
}

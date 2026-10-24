import { sql } from "drizzle-orm";
import { z } from "zod";

import type { Db, Executor, Tx } from "@/db";
import { participants, registrationImports, teams } from "@/db/schema";
import { AppError } from "@/lib/errors";
import {
  assignTeamCodes,
  buildTeams,
  mappingSchema,
  MAX_IMPORT_ROWS,
  normalizeKey,
  normalizePhone,
  prepareTable,
  type BuildResult,
  type CandidateMember,
  type CandidateTeam,
  type ImportIssue,
} from "@/lib/registration-import";
import { assertPermission, type Actor } from "@/server/auth/permissions";
import { writeAudit } from "./audit";
import { parseInput } from "./validation";

export const IMPORT_MODES = ["add_only", "update_existing"] as const;
export type ImportMode = (typeof IMPORT_MODES)[number];

export const importRequestSchema = z.object({
  fileName: z.string().trim().min(1).max(255),
  sheetName: z.string().max(255).nullish(),
  /** Row index of the header (null = no header row), as chosen on screen. */
  headerRow: z.number().int().min(0).nullable(),
  raw: z.array(z.array(z.string().max(2000)).max(300)).min(1, "The file has no rows").max(MAX_IMPORT_ROWS),
  mapping: mappingSchema,
  mode: z.enum(IMPORT_MODES),
  /** Registration keys the organizer unticked during review. */
  skipKeys: z.array(z.string().max(500)).max(MAX_IMPORT_ROWS).default([]),
});
export type ImportRequest = z.input<typeof importRequestSchema>;

export type TeamAction =
  | "create" // new registration
  | "update" // existing team; new members or changed details (update mode)
  | "unchanged" // existing team, nothing new
  | "skip_existing" // existing team with differences, add-only mode
  | "blocked" // can't be applied safely
  | "deselected"; // unticked by the organizer

export type MemberChange = { kind: "add" | "update"; name: string; detail: string };

export type AnalyzedTeam = Omit<CandidateTeam, "sourceCells"> & {
  action: TeamAction;
  finalCode: string;
  existingTeamId: string | null;
  existingName: string | null;
  changes: string[];
  memberChanges: MemberChange[];
  /** Members already in the database but not in this file (always kept). */
  notInFile: string[];
  blockReason: string | null;
};

export type ImportSummary = {
  totalRows: number;
  blankRows: number;
  excludedRows: number;
  skippedRows: number;
  errors: number;
  warnings: number;
  teamsInFile: number;
  participantsInFile: number;
  create: number;
  update: number;
  unchanged: number;
  skipExisting: number;
  blocked: number;
  deselected: number;
  participantsToCreate: number;
  participantsToUpdate: number;
};

export type ImportAnalysis = { summary: ImportSummary; teams: AnalyzedTeam[]; issues: ImportIssue[] };
export type ImportReport = ImportAnalysis & { importId: string; committedAt: string };

type ExistingTeam = {
  id: string;
  teamCode: string;
  teamName: string;
  teamNameKey: string;
  registrationKey: string;
  college: string | null;
  archivedAt: Date | null;
};
type ExistingMember = {
  id: string;
  teamId: string;
  name: string;
  email: string | null;
  phone: string | null;
  externalId: string | null;
  identityKey: string;
  isLeader: boolean;
  withdrawnAt: Date | null;
};

async function loadExisting(exec: Executor) {
  const [teamRows, memberRows] = await Promise.all([
    exec
      .select({
        id: teams.id,
        teamCode: teams.teamCode,
        teamName: teams.teamName,
        teamNameKey: teams.teamNameKey,
        registrationKey: teams.registrationKey,
        college: teams.college,
        archivedAt: teams.archivedAt,
      })
      .from(teams),
    exec
      .select({
        id: participants.id,
        teamId: participants.teamId,
        name: participants.name,
        email: participants.email,
        phone: participants.phone,
        externalId: participants.externalId,
        identityKey: participants.identityKey,
        isLeader: participants.isLeader,
        withdrawnAt: participants.withdrawnAt,
      })
      .from(participants),
  ]);
  return { teamRows, memberRows };
}

const phoneKey = (p: string | null) => {
  const d = normalizePhone(p);
  return d ? d.slice(-10) : null;
};

/** Finds the database record for a file member within the same team. */
function matchMember(m: CandidateMember, existing: ExistingMember[]): ExistingMember | null {
  return (
    existing.find((e) => e.identityKey === m.identityKey) ??
    existing.find((e) => !!m.externalId && e.externalId === m.externalId) ??
    existing.find((e) => !!m.email && e.email === m.email) ??
    existing.find((e) => !!phoneKey(m.phone) && phoneKey(e.phone) === phoneKey(m.phone)) ??
    existing.find((e) => normalizeKey(e.name) === normalizeKey(m.name)) ??
    null
  );
}

function prepare(input: z.infer<typeof importRequestSchema>): BuildResult {
  const table = prepareTable(input.raw, { headerRow: input.headerRow });
  if (input.headerRow !== null && input.headerRow >= input.raw.length) throw new AppError("VALIDATION", "The header row is outside the file.");
  const width = table.headers.length;
  const cols = [
    input.mapping.teamName,
    input.mapping.teamCode,
    input.mapping.college,
    input.mapping.declaredSize,
    input.mapping.declaredRegistered,
    input.mapping.role,
    ...[input.mapping.leader, input.mapping.person, ...input.mapping.members].flatMap((s) => Object.values(s)),
  ];
  if (cols.some((c) => c !== null && c >= width)) throw new AppError("VALIDATION", "The column mapping refers to a column that is not in the file.");
  return buildTeams(table, input.mapping);
}

async function analyze(exec: Executor, input: z.infer<typeof importRequestSchema>): Promise<ImportAnalysis> {
  const built = prepare(input);
  const { teamRows, memberRows } = await loadExisting(exec);
  const issues: ImportIssue[] = [...built.issues];

  const byKey = new Map(teamRows.map((t) => [t.registrationKey, t]));
  const byCode = new Map(teamRows.map((t) => [t.teamCode, t]));
  const membersByTeam = new Map<string, ExistingMember[]>();
  for (const m of memberRows) membersByTeam.set(m.teamId, [...(membersByTeam.get(m.teamId) ?? []), m]);
  const teamById = new Map(teamRows.map((t) => [t.id, t]));
  const skip = new Set(input.skipKeys);

  // Leader email/phone -> existing team, to recognise a renamed team.
  const leaderIndex = new Map<string, ExistingTeam[]>();
  for (const m of memberRows) {
    if (!m.isLeader || m.withdrawnAt) continue;
    for (const k of [m.email ? `e:${m.email}` : null, phoneKey(m.phone) ? `p:${phoneKey(m.phone)}` : null]) {
      if (!k) continue;
      const t = teamById.get(m.teamId);
      if (t) leaderIndex.set(k, [...(leaderIndex.get(k) ?? []), t]);
    }
  }
  // Email/phone -> team for cross-team duplicate participant warnings.
  const contactIndex = new Map<string, { team: ExistingTeam; name: string }>();
  for (const m of memberRows) {
    if (m.withdrawnAt) continue;
    const t = teamById.get(m.teamId);
    if (!t || t.archivedAt) continue;
    if (m.email) contactIndex.set(`e:${m.email}`, { team: t, name: m.name });
    if (phoneKey(m.phone)) contactIndex.set(`p:${phoneKey(m.phone)}`, { team: t, name: m.name });
  }
  const nameIndex = new Map<string, ExistingTeam[]>();
  for (const t of teamRows) if (!t.archivedAt) nameIndex.set(t.teamNameKey, [...(nameIndex.get(t.teamNameKey) ?? []), t]);

  const takenCodes = new Set(teamRows.map((t) => t.teamCode));
  const analyzed: AnalyzedTeam[] = [];
  const newTeams: AnalyzedTeam[] = [];

  for (const candidate of built.teams) {
    const { sourceCells: _cells, ...team } = candidate;
    let existing: ExistingTeam | null = byKey.get(team.key) ?? (team.teamCode ? (byCode.get(team.teamCode) ?? null) : null);
    const leader = team.members.find((m) => m.isLeader);
    let matchedByLeader = false;
    if (!existing && leader && input.mode === "update_existing") {
      const hits = [
        ...(leader.email ? (leaderIndex.get(`e:${leader.email}`) ?? []) : []),
        ...(phoneKey(leader.phone) ? (leaderIndex.get(`p:${phoneKey(leader.phone)}`) ?? []) : []),
      ];
      const unique = [...new Set(hits)];
      if (unique.length === 1) {
        existing = unique[0];
        matchedByLeader = true;
      }
    }

    const entry: AnalyzedTeam = {
      ...team,
      action: "create",
      finalCode: "",
      existingTeamId: existing?.id ?? null,
      existingName: existing?.teamName ?? null,
      changes: [],
      memberChanges: [],
      notInFile: [],
      blockReason: null,
    };
    analyzed.push(entry);

    if (!existing) {
      if (team.teamCode && takenCodes.has(team.teamCode)) {
        entry.action = "blocked";
        entry.blockReason = `Team code ${team.teamCode} is already used by another team.`;
      } else {
        newTeams.push(entry);
        for (const other of nameIndex.get(team.teamNameKey) ?? []) {
          const msg = `A different registration named "${other.teamName}" (${other.teamCode}) already exists. This one has a different leader and will be imported as a separate team.`;
          issues.push({ severity: "warning", rowNumbers: team.rowNumbers, team: team.teamName, message: msg });
          entry.warnings.push(msg);
        }
      }
      for (const m of team.members) {
        const hit = (m.email && contactIndex.get(`e:${m.email}`)) || (phoneKey(m.phone) && contactIndex.get(`p:${phoneKey(m.phone)}`)) || null;
        if (hit) {
          const msg = `${m.name} is already registered in team "${hit.team.teamName}" (${hit.team.teamCode}). Duplicate participant: decide which team they belong to.`;
          issues.push({ severity: "warning", rowNumbers: [m.rowNumber], team: team.teamName, message: msg });
          entry.warnings.push(msg);
        }
      }
      continue;
    }

    entry.finalCode = existing.teamCode;
    if (existing.archivedAt) {
      entry.action = "blocked";
      entry.blockReason = `Matches archived team ${existing.teamName} (${existing.teamCode}). Restore it first.`;
      continue;
    }
    if (matchedByLeader) {
      const msg = `Matched existing team "${existing.teamName}" (${existing.teamCode}) by its leader's contact details.`;
      issues.push({ severity: "info", rowNumbers: team.rowNumbers, team: team.teamName, message: msg });
    }

    if (existing.teamName !== team.teamName) entry.changes.push(`name: ${existing.teamName} → ${team.teamName}`);
    if (team.college && existing.college !== team.college) entry.changes.push(`college: ${existing.college ?? "—"} → ${team.college}`);

    const dbMembers = membersByTeam.get(existing.id) ?? [];
    const matched = new Set<string>();
    for (const m of team.members) {
      const hit = matchMember(m, dbMembers);
      if (!hit) {
        entry.memberChanges.push({ kind: "add", name: m.name, detail: "new member" });
        continue;
      }
      matched.add(hit.id);
      if (hit.withdrawnAt) {
        issues.push({ severity: "info", rowNumbers: [m.rowNumber], team: team.teamName, message: `${m.name} is withdrawn in the system and stays withdrawn.` });
        continue;
      }
      const diffs: string[] = [];
      if (hit.name !== m.name) diffs.push(`name ${hit.name} → ${m.name}`);
      if (m.email && hit.email !== m.email) diffs.push(`email ${hit.email ?? "—"} → ${m.email}`);
      if (m.phone && phoneKey(hit.phone) !== phoneKey(m.phone)) diffs.push(`phone ${hit.phone ?? "—"} → ${m.phone}`);
      if (m.isLeader && !hit.isLeader) diffs.push("becomes leader");
      if (diffs.length > 0) entry.memberChanges.push({ kind: "update", name: m.name, detail: diffs.join(", ") });
    }
    entry.notInFile = dbMembers.filter((d) => !matched.has(d.id) && !d.withdrawnAt).map((d) => d.name);
    if (entry.notInFile.length > 0) {
      issues.push({
        severity: "info",
        rowNumbers: team.rowNumbers,
        team: team.teamName,
        message: `Not in this file but kept in the system: ${entry.notInFile.join(", ")}.`,
      });
    }

    const hasChanges = entry.changes.length > 0 || entry.memberChanges.length > 0;
    entry.action = !hasChanges ? "unchanged" : input.mode === "update_existing" ? "update" : "skip_existing";
  }

  const codes = assignTeamCodes(
    newTeams.map((t) => ({ teamName: t.teamName, teamCode: t.teamCode })),
    takenCodes,
  );
  newTeams.forEach((t, i) => (t.finalCode = codes[i]));

  for (const t of analyzed) {
    if (skip.has(t.key) && (t.action === "create" || t.action === "update")) t.action = "deselected";
  }

  const count = (a: TeamAction) => analyzed.filter((t) => t.action === a).length;
  const summary: ImportSummary = {
    totalRows: built.totalRows,
    blankRows: built.blankRows,
    excludedRows: built.excludedRows,
    skippedRows: built.skippedRows.length,
    errors: issues.filter((i) => i.severity === "error").length,
    warnings: issues.filter((i) => i.severity === "warning").length,
    teamsInFile: built.teams.length,
    participantsInFile: built.teams.reduce((s, t) => s + t.members.length, 0),
    create: count("create"),
    update: count("update"),
    unchanged: count("unchanged"),
    skipExisting: count("skip_existing"),
    blocked: count("blocked"),
    deselected: count("deselected"),
    participantsToCreate:
      analyzed.filter((t) => t.action === "create").reduce((s, t) => s + t.members.length, 0) +
      analyzed.filter((t) => t.action === "update").reduce((s, t) => s + t.memberChanges.filter((c) => c.kind === "add").length, 0),
    participantsToUpdate: analyzed
      .filter((t) => t.action === "update")
      .reduce((s, t) => s + t.memberChanges.filter((c) => c.kind === "update").length, 0),
  };
  return { summary, teams: analyzed, issues };
}

export async function analyzeImport(db: Db, actor: Actor | null, raw: unknown): Promise<ImportAnalysis> {
  assertPermission(actor, "teams:import");
  return analyze(db, parseInput(importRequestSchema, raw));
}

function memberRow(m: CandidateMember, teamId: string, importId: string) {
  return {
    teamId,
    name: m.name,
    email: m.email,
    phone: m.phone,
    externalId: m.externalId,
    identityKey: m.identityKey,
    isLeader: m.isLeader,
    position: m.position,
    source: { importId, rowNumber: m.rowNumber },
  };
}

async function applyUpdate(tx: Tx, team: AnalyzedTeam, importId: string) {
  const teamId = team.existingTeamId!;
  // Re-read under lock so nothing changes between analysis and write.
  await tx.execute(sql`select 1 from ${teams} where ${teams.id} = ${teamId} for update`);
  const dbMembers = (await tx.select().from(participants).where(sql`${participants.teamId} = ${teamId}`)) as ExistingMember[];

  await tx
    .update(teams)
    .set({
      teamName: team.teamName,
      teamNameKey: team.teamNameKey,
      college: team.college ?? sql`${teams.college}`,
      declaredMemberCount: team.declaredSize ?? sql`${teams.declaredMemberCount}`,
      declaredRegisteredCount: team.declaredRegistered ?? sql`${teams.declaredRegisteredCount}`,
      updatedAt: new Date(),
    })
    .where(sql`${teams.id} = ${teamId}`);

  const newLeader = team.members.find((m) => m.isLeader);
  const leaderHit = newLeader ? matchMember(newLeader, dbMembers) : null;
  if (newLeader && !leaderHit?.isLeader) {
    // Clear the old leader first: one leader per team is a unique index.
    await tx.update(participants).set({ isLeader: false }).where(sql`${participants.teamId} = ${teamId} and ${participants.isLeader}`);
  }

  let position = dbMembers.length;
  for (const m of team.members) {
    const hit = matchMember(m, dbMembers);
    if (!hit) {
      await tx.insert(participants).values({ ...memberRow(m, teamId, importId), position: position++ });
      continue;
    }
    if (hit.withdrawnAt) continue;
    await tx
      .update(participants)
      .set({
        name: m.name,
        email: m.email ?? hit.email,
        phone: m.phone ?? hit.phone,
        externalId: m.externalId ?? hit.externalId,
        isLeader: m.isLeader || (hit.isLeader && !newLeader),
        updatedAt: new Date(),
      })
      .where(sql`${participants.id} = ${hit.id}`);
  }
}

/**
 * Imports in one transaction: the analysis is recomputed inside it (the
 * preview is never trusted) under an advisory lock that serialises imports.
 * Imports only add teams/members or update registration details; they never
 * touch check-ins, coupons or room allocations, and never remove members.
 */
export async function commitImport(db: Db, actor: Actor | null, raw: unknown): Promise<ImportReport> {
  assertPermission(actor, "teams:import");
  const input = parseInput(importRequestSchema, raw);

  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('hackathon-ops:registration-import'))`);
    const analysis = await analyze(tx, input);
    const importId = crypto.randomUUID();

    await tx.insert(registrationImports).values({
      id: importId,
      fileName: input.fileName + (input.sheetName && input.sheetName !== input.fileName ? ` [${input.sheetName}]` : ""),
      layout: input.mapping.layout,
      mode: input.mode,
      createdBy: actor.id,
      summary: analysis.summary,
      issues: analysis.issues.slice(0, 2000),
    });

    const table = prepareTable(input.raw, { headerRow: input.headerRow });
    const rowByNumber = new Map(table.rows.map((r) => [r.rowNumber, r.cells]));
    const sourceOf = (team: AnalyzedTeam) => ({
      importId,
      fileName: input.fileName,
      sheet: input.sheetName ?? null,
      rowNumbers: team.rowNumbers,
      row: Object.fromEntries(table.headers.map((h, i) => [h, rowByNumber.get(team.rowNumbers[0])?.[i] ?? ""])),
    });

    const toCreate = analysis.teams.filter((t) => t.action === "create");
    for (let i = 0; i < toCreate.length; i += 200) {
      const chunk = toCreate.slice(i, i + 200);
      const inserted = await tx
        .insert(teams)
        .values(
          chunk.map((t) => ({
            teamCode: t.finalCode,
            teamName: t.teamName,
            teamNameKey: t.teamNameKey,
            registrationKey: t.key,
            college: t.college,
            declaredMemberCount: t.declaredSize,
            declaredRegisteredCount: t.declaredRegistered,
            sourceImportId: importId,
            source: sourceOf(t),
          })),
        )
        .returning({ id: teams.id, registrationKey: teams.registrationKey });
      const idByKey = new Map(inserted.map((r) => [r.registrationKey, r.id]));
      const members = chunk.flatMap((t) => t.members.map((m) => memberRow(m, idByKey.get(t.key)!, importId)));
      for (let j = 0; j < members.length; j += 500) await tx.insert(participants).values(members.slice(j, j + 500));
    }

    const toUpdate = analysis.teams.filter((t) => t.action === "update");
    for (const t of toUpdate) await applyUpdate(tx, t, importId);

    await writeAudit(tx, actor, [
      {
        action: "csv_import",
        details: { importId, fileName: input.fileName, sheet: input.sheetName ?? null, mode: input.mode, summary: analysis.summary },
      },
      ...toUpdate.map((t) => ({
        action: "team_update" as const,
        teamId: t.existingTeamId,
        teamLabel: `${t.teamName} (${t.finalCode})`,
        reason: `Registration import ${input.fileName}`,
        details: { importId, changes: t.changes, memberChanges: t.memberChanges },
      })),
    ]);

    return { ...analysis, importId, committedAt: new Date().toISOString() };
  });
}

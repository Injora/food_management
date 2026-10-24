import { asc, sql } from "drizzle-orm";
import { z } from "zod";

import type { Db, Executor } from "@/db";
import { teamSubmissions } from "@/db/schema";
import { matchSubmissionTeam, safeRepoUrl, type MatchableTeam, type Submission } from "@/lib/submissions";
import { assertPermission, type Actor } from "@/server/auth/permissions";
import { parseInput } from "./validation";

/** Form responses for the judging panel, oldest first. Super admins only. */
export async function listSubmissions(exec: Executor, actor: Actor | null): Promise<Submission[]> {
  assertPermission(actor, "eval:score");
  const rows = await exec.select().from(teamSubmissions).orderBy(asc(teamSubmissions.position));
  return rows.map((r) => ({
    id: r.id,
    teamId: r.teamId,
    submittedAt: r.submittedAt,
    teamName: r.teamName,
    leaderName: r.leaderName,
    title: r.title,
    description: r.description,
    repoUrl: r.repoUrl,
    psMatch: r.psMatch as Submission["psMatch"],
    matchedStatement: r.matchedStatement,
    notes: r.notes,
  }));
}

const text = (max: number) => z.string().trim().max(max).nullable();
const replaceSchema = z.object({
  fileName: z.string().trim().min(1).max(255),
  rows: z
    .array(
      z.object({
        submittedAt: text(40),
        teamName: z.string().trim().min(1).max(200),
        leaderName: text(200),
        title: text(500),
        description: text(5000),
        repoUrl: text(500),
        psMatch: z.enum(["yes", "partial", "no"]).nullable(),
        matchedStatement: text(300),
        notes: text(2000),
      }),
    )
    .min(1)
    .max(5000),
});

/**
 * Replaces the stored form responses and links each to its website team.
 * Touches only team_submissions. Returns the responses no team matched.
 */
export async function replaceSubmissions(db: Db, actor: Actor | null, raw: unknown) {
  assertPermission(actor, "eval:score");
  const input = parseInput(replaceSchema, raw);
  return db.transaction(async (tx) => {
    const teamRows = await tx.execute(sql`
      select t.id, t.team_name as name,
        (select p.name from participants p where p.team_id = t.id and p.is_leader and p.withdrawn_at is null limit 1) as "leaderName",
        coalesce((select array_agg(p.name) from participants p where p.team_id = t.id and p.withdrawn_at is null), '{}') as members,
        exists(select 1 from check_ins c where c.team_id = t.id and c.undone_at is null) as active
      from teams t where t.archived_at is null`);
    const teams = teamRows.rows as MatchableTeam[];

    const values = input.rows.map((r, i) => ({
      ...r,
      repoUrl: safeRepoUrl(r.repoUrl),
      position: i,
      fileName: input.fileName,
      teamId: matchSubmissionTeam(r, teams),
    }));
    await tx.delete(teamSubmissions);
    for (let i = 0; i < values.length; i += 500) await tx.insert(teamSubmissions).values(values.slice(i, i + 500));
    return {
      rows: values.length,
      matchedTeams: new Set(values.map((v) => v.teamId).filter(Boolean)).size,
      unmatched: values.filter((v) => !v.teamId).map((v) => `${v.teamName}${v.leaderName ? ` (${v.leaderName})` : ""}`),
    };
  });
}

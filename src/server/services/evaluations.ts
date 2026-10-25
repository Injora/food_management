import { and, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";

import type { Db, Executor } from "@/db";
import { teamEvaluationChanges, teamEvaluations, teams, users } from "@/db/schema";
import { AppError } from "@/lib/errors";
import { EVAL_PHASES, FINALISTS, MID_RUBRIC, MIN_SCORE, OPEN_EVAL_PHASES, rankEvaluations, RUBRICS, SCORE_FIELDS, TRACKS, type ScoreField, type Track } from "@/lib/evaluation";
import { assertPermission, type Actor } from "@/server/auth/permissions";
import { parseInput } from "./validation";

export type EvaluationRow = {
  teamId: string;
  teamCode: string;
  teamName: string;
  leaderName: string | null;
  roomNumber: string | null;
  size: number;
  present: number;
  track: Track | null;
  updatedAt: string | null;
  updatedBy: string | null;
} & Record<ScoreField, number | null>;

const phaseSchema = z.enum(EVAL_PHASES).refine((p) => OPEN_EVAL_PHASES.includes(p), "This evaluation isn't open yet.");

/**
 * The teams being judged in the phase with their score sheets. Mid: every
 * active team (sheets are empty until a judge scores them). Final: only the
 * finalists, whose sheets were created when they qualified.
 */
export async function listEvaluations(exec: Executor, actor: Actor | null, rawPhase: unknown): Promise<EvaluationRow[]> {
  assertPermission(actor, "eval:score");
  const phase = parseInput(phaseSchema, rawPhase);
  const result = await exec.execute(sql`
    select t.id as "teamId", t.team_code as "teamCode", t.team_name as "teamName",
      (select p.name from participants p where p.team_id = t.id and p.is_leader and p.withdrawn_at is null limit 1) as "leaderName",
      coalesce(e.room, (select r.room_number from team_room_assignments a join rooms r on r.id = a.room_id
        where a.team_id = t.id and a.session_id = 'hackathon')) as "roomNumber",
      (select count(*)::int from participants p where p.team_id = t.id and p.withdrawn_at is null) as "size",
      (select count(*)::int from check_ins c join participants p on p.id = c.participant_id
        where c.team_id = t.id and c.undone_at is null and p.withdrawn_at is null) as "present",
      e.track, e.score1, e.score2, e.score3, e.score4, e.score5, e.score6,
      e.updated_at as "updatedAt", u.email as "updatedBy"
    from teams t
    ${phase === "final" ? sql`join` : sql`left join`} team_evaluations e on e.team_id = t.id and e.phase = ${phase}
    left join users u on u.id = e.updated_by
    where t.archived_at is null
    order by lower(t.team_name)`);
  return (result.rows as (EvaluationRow & { updatedAt: Date | string | null })[]).map((r) => ({
    ...r,
    updatedAt: r.updatedAt ? new Date(r.updatedAt).toISOString() : null,
  }));
}

const saveSchema = z.discriminatedUnion("field", [
  z.object({ phase: phaseSchema, teamId: z.uuid("Invalid team"), field: z.literal("track"), value: z.enum(TRACKS).nullable() }),
  z
    .object({
      phase: phaseSchema,
      teamId: z.uuid("Invalid team"),
      field: z.enum(SCORE_FIELDS),
      value: z.number().int("Scores are whole numbers").nullable(),
    })
    .superRefine(({ phase, field, value }, ctx) => {
      const rubric = RUBRICS[phase];
      if (!rubric.metrics.some((m) => m.field === field)) {
        ctx.addIssue({ code: "custom", path: ["field"], message: "That metric isn't part of this evaluation." });
      } else if (value != null && (value < MIN_SCORE || value > rubric.maxScore)) {
        ctx.addIssue({ code: "custom", path: ["value"], message: `Scores are ${MIN_SCORE} to ${rubric.maxScore}` });
      }
    }),
]);

/**
 * Sets one field of a team's score sheet. Saving one field at a time means two
 * judges working on the same team never overwrite each other's other marks.
 * Every change is recorded with who made it.
 */
export async function saveEvaluation(db: Db, actor: Actor | null, raw: unknown) {
  assertPermission(actor, "eval:score");
  const input = parseInput(saveSchema, raw);

  return db.transaction(async (tx) => {
    const [team] = await tx
      .select({ id: teams.id })
      .from(teams)
      .where(and(eq(teams.id, input.teamId), isNull(teams.archivedAt)))
      .for("share");
    if (!team) throw new AppError("NOT_FOUND", "Team not found.");

    // Final sheets exist only for finalists (see scripts/qualify-final.mts).
    if (input.phase !== "final") {
      await tx.insert(teamEvaluations).values({ phase: input.phase, teamId: team.id }).onConflictDoNothing();
    }
    const [current] = await tx
      .select()
      .from(teamEvaluations)
      .where(and(eq(teamEvaluations.phase, input.phase), eq(teamEvaluations.teamId, team.id)))
      .for("update");
    if (!current) throw new AppError("NOT_FOUND", "This team isn't in the final evaluation.");

    const before = current[input.field];
    if (before !== input.value) {
      await tx
        .update(teamEvaluations)
        .set({ [input.field]: input.value, updatedAt: sql`now()`, updatedBy: actor.id })
        .where(eq(teamEvaluations.id, current.id));
      await tx.insert(teamEvaluationChanges).values({
        evaluationId: current.id,
        field: input.field,
        before: before == null ? null : String(before),
        after: input.value == null ? null : String(input.value),
        changedBy: actor.id,
        changedByEmail: actor.email,
      });
    }
    const [after] = await tx
      .select({
        track: teamEvaluations.track,
        score1: teamEvaluations.score1,
        score2: teamEvaluations.score2,
        score3: teamEvaluations.score3,
        score4: teamEvaluations.score4,
        score5: teamEvaluations.score5,
        score6: teamEvaluations.score6,
        updatedAt: teamEvaluations.updatedAt,
        updatedBy: users.email,
      })
      .from(teamEvaluations)
      .leftJoin(users, eq(users.id, teamEvaluations.updatedBy))
      .where(eq(teamEvaluations.id, current.id));
    return { teamId: team.id, ...after, updatedAt: after.updatedAt.toISOString() };
  });
}

const finalistsSchema = z.object({
  count: z.number().int().min(1).default(FINALISTS),
  /** Team names to leave out, matched exactly but ignoring case and spaces at the ends. */
  exclude: z.array(z.string().trim().min(1)).default([]),
});

export type Finalist = { teamId: string; teamName: string; midRank: number; midTotal: number; track: Track | null };

/**
 * The top teams of the mid evaluation, ranked exactly as the panel ranks them,
 * leaving out the excluded teams. Refuses if the cut-off falls inside a tie.
 */
export async function pickFinalists(exec: Executor, actor: Actor | null, raw: unknown): Promise<Finalist[]> {
  assertPermission(actor, "eval:score");
  const input = parseInput(finalistsSchema, raw);
  const ranked = rankEvaluations(MID_RUBRIC, await listEvaluations(exec, actor, "mid"));

  const excluded = new Set(input.exclude.map((n) => n.toLowerCase()));
  for (const name of excluded) {
    if (!ranked.some((r) => r.teamName.trim().toLowerCase() === name)) {
      throw new AppError("NOT_FOUND", `No scored team called "${name}".`);
    }
  }
  const eligible = ranked.filter((r) => !excluded.has(r.teamName.trim().toLowerCase()));
  if (eligible.length < input.count) {
    throw new AppError("CONFLICT", `Only ${eligible.length} teams are fully scored, fewer than ${input.count}.`);
  }
  const last = eligible[input.count - 1];
  const next = eligible[input.count];
  if (next && next.rank === last.rank) {
    throw new AppError("CONFLICT", `${last.teamName} and ${next.teamName} tie at the cut-off; separate them in the mid evaluation first.`);
  }
  return eligible.slice(0, input.count).map((r) => ({ teamId: r.teamId, teamName: r.teamName, midRank: r.rank, midTotal: r.final, track: r.track }));
}

/**
 * Creates the final-evaluation score sheets for the finalists, carrying over
 * each team's track. Only these teams appear in, and can be scored in, the
 * final. Runs once: refuses if any final sheet already exists.
 */
export async function qualifyFinalists(db: Db, actor: Actor | null, raw: unknown): Promise<Finalist[]> {
  assertPermission(actor, "eval:score");
  return db.transaction(async (tx) => {
    // Serializes concurrent runs: only one can find the final empty.
    await tx.execute(sql`lock table team_evaluations in share row exclusive mode`);
    const [{ existing }] = (await tx.execute(sql`select count(*)::int as existing from team_evaluations where phase = 'final'`)).rows as { existing: number }[];
    if (existing > 0) throw new AppError("CONFLICT", `The final already has ${existing} teams.`);

    const finalists = await pickFinalists(tx, actor, raw);
    const sheets = await tx
      .insert(teamEvaluations)
      .values(finalists.map((f) => ({ phase: "final" as const, teamId: f.teamId, track: f.track, updatedBy: actor.id })))
      .returning({ id: teamEvaluations.id, teamId: teamEvaluations.teamId });
    const byTeam = new Map(finalists.map((f) => [f.teamId, f]));
    await tx.insert(teamEvaluationChanges).values(
      sheets.map((sheet) => {
        const f = byTeam.get(sheet.teamId)!;
        return {
          evaluationId: sheet.id,
          field: "qualified",
          after: `mid #${f.midRank}, ${f.midTotal}/${MID_RUBRIC.totalMarks}`,
          changedBy: actor.id,
          changedByEmail: actor.email,
        };
      }),
    );
    return finalists;
  });
}

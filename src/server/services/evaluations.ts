import { and, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";

import type { Db, Executor } from "@/db";
import { teamEvaluationChanges, teamEvaluations, teams, users } from "@/db/schema";
import { AppError } from "@/lib/errors";
import { EVAL_PHASES, MAX_SCORE, MIN_SCORE, OPEN_EVAL_PHASES, SCORE_FIELDS, TRACKS, type ScoreField, type Track } from "@/lib/evaluation";
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

/** Every active team with its score sheet for the phase (empty until a judge scores it). */
export async function listEvaluations(exec: Executor, actor: Actor | null, rawPhase: unknown): Promise<EvaluationRow[]> {
  assertPermission(actor, "eval:score");
  const phase = parseInput(phaseSchema, rawPhase);
  const result = await exec.execute(sql`
    select t.id as "teamId", t.team_code as "teamCode", t.team_name as "teamName",
      (select p.name from participants p where p.team_id = t.id and p.is_leader and p.withdrawn_at is null limit 1) as "leaderName",
      (select r.room_number from team_room_assignments a join rooms r on r.id = a.room_id
        where a.team_id = t.id and a.session_id = 'hackathon') as "roomNumber",
      (select count(*)::int from participants p where p.team_id = t.id and p.withdrawn_at is null) as "size",
      (select count(*)::int from check_ins c join participants p on p.id = c.participant_id
        where c.team_id = t.id and c.undone_at is null and p.withdrawn_at is null) as "present",
      e.track, e.score1, e.score2, e.score3, e.score4, e.score5,
      e.updated_at as "updatedAt", u.email as "updatedBy"
    from teams t
    left join team_evaluations e on e.team_id = t.id and e.phase = ${phase}
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
  z.object({
    phase: phaseSchema,
    teamId: z.uuid("Invalid team"),
    field: z.enum(SCORE_FIELDS),
    value: z
      .number()
      .int("Scores are whole numbers")
      .min(MIN_SCORE, `Scores are ${MIN_SCORE} to ${MAX_SCORE}`)
      .max(MAX_SCORE, `Scores are ${MIN_SCORE} to ${MAX_SCORE}`)
      .nullable(),
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

    await tx.insert(teamEvaluations).values({ phase: input.phase, teamId: team.id }).onConflictDoNothing();
    const [current] = await tx
      .select()
      .from(teamEvaluations)
      .where(and(eq(teamEvaluations.phase, input.phase), eq(teamEvaluations.teamId, team.id)))
      .for("update");

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
        updatedAt: teamEvaluations.updatedAt,
        updatedBy: users.email,
      })
      .from(teamEvaluations)
      .leftJoin(users, eq(users.id, teamEvaluations.updatedBy))
      .where(eq(teamEvaluations.id, current.id));
    return { teamId: team.id, ...after, updatedAt: after.updatedAt.toISOString() };
  });
}

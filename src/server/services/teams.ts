import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";

import type { Db, Executor, Tx } from "@/db";
import { distributions, teams, users } from "@/db/schema";
import { deriveTeamCode, looksLikeEmail, normalizeEmail, normalizeTeamCode, normalizeTeamKey } from "@/lib/csv-import";
import { AppError } from "@/lib/errors";
import { MEAL_TYPES, type DistributionStatus, type MealType } from "@/lib/meals";
import { assertPermission, type Actor } from "@/server/auth/permissions";
import { listAudit, writeAudit } from "./audit";
import { isUniqueViolation, parseInput } from "./validation";

export type NewTeam = {
  teamName: string;
  teamNameKey: string;
  teamCode: string;
  teamLeaderName: string | null;
  teamLeaderEmail: string | null;
  memberCount: number;
};

/** Inserts teams and their pending breakfast/lunch/dinner records, in chunks. */
export async function insertTeamsWithMeals(tx: Tx, rows: NewTeam[]) {
  const inserted: { id: string; teamCode: string; memberCount: number }[] = [];
  for (let i = 0; i < rows.length; i += 500) {
    const chunk = await tx
      .insert(teams)
      .values(rows.slice(i, i + 500))
      .returning({ id: teams.id, teamCode: teams.teamCode, memberCount: teams.memberCount });
    inserted.push(...chunk);
  }
  const meals = inserted.flatMap((t) =>
    MEAL_TYPES.map((mealType) => ({ teamId: t.id, mealType, couponQuantity: t.memberCount })),
  );
  for (let i = 0; i < meals.length; i += 1500) {
    await tx.insert(distributions).values(meals.slice(i, i + 1500));
  }
  return inserted;
}

function uniqueViolationMessage(err: unknown): AppError | null {
  if (isUniqueViolation(err, "teams_team_code_unique")) {
    return new AppError("CONFLICT", "Another team already uses that team code.");
  }
  if (isUniqueViolation(err, "teams_team_name_key_unique")) {
    return new AppError("CONFLICT", "Another team already has that name (names are compared ignoring case, spaces and punctuation).");
  }
  return null;
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export type MealState = {
  status: DistributionStatus;
  couponQuantity: number;
  issuedAt: string | null;
  issuedByName: string | null;
};

export type TeamWithMeals = {
  id: string;
  teamName: string;
  teamCode: string;
  leaderName: string | null;
  leaderEmail: string | null;
  memberCount: number;
  createdAt: string;
  updatedAt: string;
  meals: Record<MealType, MealState>;
};

async function loadTeams(exec: Executor, teamIds?: string[]): Promise<TeamWithMeals[]> {
  const teamRows = await exec
    .select()
    .from(teams)
    .where(teamIds ? inArray(teams.id, teamIds) : undefined)
    .orderBy(asc(teams.teamName));
  if (teamRows.length === 0) return [];
  const mealRows = await exec
    .select({
      teamId: distributions.teamId,
      mealType: distributions.mealType,
      status: distributions.status,
      couponQuantity: distributions.couponQuantity,
      issuedAt: distributions.issuedAt,
      issuedByName: users.name,
    })
    .from(distributions)
    .leftJoin(users, eq(users.id, distributions.issuedBy))
    .where(teamIds ? inArray(distributions.teamId, teamIds) : undefined);

  const byTeam = new Map<string, Partial<Record<MealType, MealState>>>();
  for (const m of mealRows) {
    const entry = byTeam.get(m.teamId) ?? {};
    entry[m.mealType] = {
      status: m.status,
      couponQuantity: m.couponQuantity,
      issuedAt: m.issuedAt?.toISOString() ?? null,
      issuedByName: m.issuedByName,
    };
    byTeam.set(m.teamId, entry);
  }
  return teamRows.map((t) => ({
    id: t.id,
    teamName: t.teamName,
    teamCode: t.teamCode,
    leaderName: t.teamLeaderName,
    leaderEmail: t.teamLeaderEmail,
    memberCount: t.memberCount,
    createdAt: t.createdAt.toISOString(),
    updatedAt: t.updatedAt.toISOString(),
    meals: byTeam.get(t.id) as Record<MealType, MealState>,
  }));
}

export async function listTeams(db: Db, actor: Actor | null): Promise<TeamWithMeals[]> {
  assertPermission(actor, "teams:view");
  return loadTeams(db);
}

export async function getTeamDetail(db: Db, actor: Actor | null, teamId: string) {
  assertPermission(actor, "teams:view");
  if (!z.uuid().safeParse(teamId).success) throw new AppError("NOT_FOUND", "Team not found.");
  const [team] = await loadTeams(db, [teamId]);
  if (!team) throw new AppError("NOT_FOUND", "Team not found.");
  const { rows: history } = await listAudit(db, actor, { teamId, limit: 200 });
  return { team, history };
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

const teamFieldsSchema = z.object({
  teamName: z.string().trim().min(1, "Team name is required").max(120, "Team name is too long"),
  teamCode: z.string().trim().max(40, "Team code is too long").optional().default(""),
  leaderName: z.string().trim().max(120).optional().default(""),
  leaderEmail: z
    .string()
    .trim()
    .max(254)
    .optional()
    .default("")
    .refine((v) => v === "" || looksLikeEmail(v), "Leader email is not a valid email address"),
  memberCount: z
    .number({ error: "Team size must be a number" })
    .int("Team size must be a whole number")
    .min(1, "Team size must be at least 1")
    .max(1000, "Team size is too large"),
});

function toNewTeam(input: z.infer<typeof teamFieldsSchema>): NewTeam {
  const teamNameKey = normalizeTeamKey(input.teamName);
  if (!teamNameKey) throw new AppError("VALIDATION", "Team name must contain letters or digits.");
  return {
    teamName: input.teamName.replace(/\s+/g, " "),
    teamNameKey,
    teamCode: normalizeTeamCode(input.teamCode) ?? deriveTeamCode(input.teamName),
    teamLeaderName: input.leaderName || null,
    teamLeaderEmail: normalizeEmail(input.leaderEmail),
    memberCount: input.memberCount,
  };
}

export async function createTeam(db: Db, actor: Actor | null, raw: unknown) {
  assertPermission(actor, "teams:edit");
  const row = toNewTeam(parseInput(teamFieldsSchema, raw));
  try {
    return await db.transaction(async (tx) => {
      const [created] = await insertTeamsWithMeals(tx, [row]);
      await writeAudit(tx, actor, {
        action: "team_create",
        teamId: created.id,
        teamLabel: `${row.teamName} (${row.teamCode})`,
        after: { ...row },
      });
      return { id: created.id, teamCode: created.teamCode };
    });
  } catch (err) {
    throw uniqueViolationMessage(err) ?? err;
  }
}

/** Locks the team and its meal rows so issuance can't interleave with an edit. */
async function lockTeam(tx: Tx, teamId: string) {
  const [team] = await tx.select().from(teams).where(eq(teams.id, teamId)).for("update");
  if (!team) throw new AppError("NOT_FOUND", "Team not found.");
  const meals = await tx
    .select({ mealType: distributions.mealType, status: distributions.status, couponQuantity: distributions.couponQuantity })
    .from(distributions)
    .where(eq(distributions.teamId, teamId))
    .orderBy(asc(distributions.mealType))
    .for("update");
  return { team, meals, issuedMeals: meals.filter((m) => m.status === "issued").map((m) => m.mealType) };
}

const updateTeamSchema = teamFieldsSchema.extend({ teamId: z.uuid() });

/**
 * Edits team details. Changing the member count is only allowed while no meal
 * has been issued; afterwards it must go through correctMemberCount.
 */
export async function updateTeam(db: Db, actor: Actor | null, raw: unknown) {
  assertPermission(actor, "teams:edit");
  const input = parseInput(updateTeamSchema, raw);
  const next = toNewTeam(input);

  try {
    return await db.transaction(async (tx) => {
      const { team, issuedMeals } = await lockTeam(tx, input.teamId);
      // A blank code keeps the current one rather than re-deriving it.
      if (!input.teamCode) next.teamCode = team.teamCode;

      const before: Record<string, unknown> = {};
      const after: Record<string, unknown> = {};
      const fields = [
        ["teamName", team.teamName, next.teamName],
        ["teamCode", team.teamCode, next.teamCode],
        ["leaderName", team.teamLeaderName, next.teamLeaderName],
        ["leaderEmail", team.teamLeaderEmail, next.teamLeaderEmail],
        ["memberCount", team.memberCount, next.memberCount],
      ] as const;
      for (const [field, from, to] of fields) {
        if (from !== to) {
          before[field] = from;
          after[field] = to;
        }
      }
      if (Object.keys(after).length === 0) return { teamId: team.id, changed: false };

      if ("memberCount" in after && issuedMeals.length > 0) {
        throw new AppError(
          "MEMBER_COUNT_LOCKED",
          `Coupons were already issued for ${issuedMeals.join(", ")}. Use "Correct member count" and give a reason.`,
          { issuedMeals },
        );
      }

      await tx
        .update(teams)
        .set({
          teamName: next.teamName,
          teamNameKey: next.teamNameKey,
          teamCode: next.teamCode,
          teamLeaderName: next.teamLeaderName,
          teamLeaderEmail: next.teamLeaderEmail,
          memberCount: next.memberCount,
          updatedAt: sql`now()`,
        })
        .where(eq(teams.id, team.id));
      if ("memberCount" in after) {
        await tx
          .update(distributions)
          .set({ couponQuantity: next.memberCount, updatedAt: sql`now()` })
          .where(and(eq(distributions.teamId, team.id), eq(distributions.status, "pending")));
      }
      await writeAudit(tx, actor, {
        action: "team_update",
        teamId: team.id,
        teamLabel: `${next.teamName} (${next.teamCode})`,
        before,
        after,
      });
      return { teamId: team.id, changed: true };
    });
  } catch (err) {
    throw uniqueViolationMessage(err) ?? err;
  }
}

const correctMemberCountSchema = z.object({
  teamId: z.uuid(),
  memberCount: teamFieldsSchema.shape.memberCount,
  reason: z.string().trim().min(5, "Give a reason of at least 5 characters").max(500),
  /** Also change the coupon quantity of meals that are still pending. */
  updatePendingMeals: z.boolean().default(true),
});

/**
 * Admin-only correction of the member count that works after issuance.
 * Issued meals keep the quantity actually handed out; use
 * correctCouponQuantity to amend those individually.
 */
export async function correctMemberCount(db: Db, actor: Actor | null, raw: unknown) {
  assertPermission(actor, "teams:edit");
  const input = parseInput(correctMemberCountSchema, raw);

  return db.transaction(async (tx) => {
    const { team, meals } = await lockTeam(tx, input.teamId);
    if (team.memberCount === input.memberCount) {
      throw new AppError("VALIDATION", `The member count is already ${input.memberCount}.`);
    }
    await tx
      .update(teams)
      .set({ memberCount: input.memberCount, updatedAt: sql`now()` })
      .where(eq(teams.id, team.id));

    const pendingMeals = meals.filter((m) => m.status === "pending").map((m) => m.mealType);
    if (input.updatePendingMeals && pendingMeals.length > 0) {
      await tx
        .update(distributions)
        .set({ couponQuantity: input.memberCount, updatedAt: sql`now()` })
        .where(and(eq(distributions.teamId, team.id), eq(distributions.status, "pending")));
    }
    await writeAudit(tx, actor, {
      action: "member_count_correction",
      teamId: team.id,
      teamLabel: `${team.teamName} (${team.teamCode})`,
      reason: input.reason,
      before: { memberCount: team.memberCount },
      after: { memberCount: input.memberCount },
      details: {
        pendingMealsUpdated: input.updatePendingMeals ? pendingMeals : [],
        issuedMealsUnchanged: meals.filter((m) => m.status === "issued").map((m) => m.mealType),
      },
    });
    return { teamId: team.id };
  });
}

const deleteTeamSchema = z.object({
  teamId: z.uuid(),
  reason: z.string().trim().min(5, "Give a reason of at least 5 characters").max(500),
});

/** Removes a team created by mistake. Refused once any meal has been issued. */
export async function deleteTeam(db: Db, actor: Actor | null, raw: unknown) {
  assertPermission(actor, "teams:edit");
  const input = parseInput(deleteTeamSchema, raw);
  return db.transaction(async (tx) => {
    const { team, issuedMeals } = await lockTeam(tx, input.teamId);
    if (issuedMeals.length > 0) {
      throw new AppError(
        "CONFLICT",
        `Can't delete ${team.teamName}: coupons were issued for ${issuedMeals.join(", ")}. Revert those first.`,
      );
    }
    await writeAudit(tx, actor, {
      action: "team_delete",
      teamId: team.id,
      teamLabel: `${team.teamName} (${team.teamCode})`,
      reason: input.reason,
      before: {
        teamName: team.teamName,
        teamCode: team.teamCode,
        leaderName: team.teamLeaderName,
        leaderEmail: team.teamLeaderEmail,
        memberCount: team.memberCount,
      },
    });
    await tx.delete(distributions).where(eq(distributions.teamId, team.id));
    await tx.delete(teams).where(eq(teams.id, team.id));
    return { teamId: team.id };
  });
}

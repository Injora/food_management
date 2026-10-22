import { and, asc, eq, sql } from "drizzle-orm";
import { z } from "zod";

import type { Db } from "@/db";
import { distributions, teams, users } from "@/db/schema";
import { AppError } from "@/lib/errors";
import { MEAL_LABELS, MEAL_TYPES, type DistributionStatus, type MealType } from "@/lib/meals";
import { assertPermission, type Actor } from "@/server/auth/permissions";
import { writeAudit } from "./audit";
import { parseInput } from "./validation";

export type MealRow = {
  teamId: string;
  teamName: string;
  teamCode: string;
  leaderName: string | null;
  leaderEmail: string | null;
  memberCount: number;
  couponQuantity: number;
  status: DistributionStatus;
  issuedAt: string | null;
  issuedByName: string | null;
};

const mealSchema = z.enum(MEAL_TYPES, { error: "Unknown meal" });

export async function listMealDistribution(db: Db, actor: Actor | null, meal: unknown): Promise<MealRow[]> {
  assertPermission(actor, "distribution:view");
  const mealType = parseInput(mealSchema, meal);
  const rows = await db
    .select({
      teamId: teams.id,
      teamName: teams.teamName,
      teamCode: teams.teamCode,
      leaderName: teams.teamLeaderName,
      leaderEmail: teams.teamLeaderEmail,
      memberCount: teams.memberCount,
      couponQuantity: distributions.couponQuantity,
      status: distributions.status,
      issuedAt: distributions.issuedAt,
      issuedByName: users.name,
    })
    .from(distributions)
    .innerJoin(teams, eq(teams.id, distributions.teamId))
    .leftJoin(users, eq(users.id, distributions.issuedBy))
    .where(eq(distributions.mealType, mealType))
    .orderBy(asc(teams.teamName));
  return rows.map((r) => ({ ...r, issuedAt: r.issuedAt?.toISOString() ?? null }));
}

// ---------------------------------------------------------------------------
// Issuance
// ---------------------------------------------------------------------------

export const issueInputSchema = z.object({
  teamId: z.uuid("Invalid team"),
  meal: mealSchema,
  /** The quantity the organizer confirmed on screen. */
  expectedQuantity: z.number().int().positive(),
  /** Generated once per confirmation; retries reuse it. */
  requestId: z.uuid(),
});
export type IssueInput = z.infer<typeof issueInputSchema>;

export type IssueResult = {
  teamId: string;
  teamName: string;
  meal: MealType;
  couponQuantity: number;
  issuedAt: string;
  issuedByName: string;
  /** True when this request had already succeeded (e.g. a network retry). */
  replayed: boolean;
};

/**
 * Marks a team's meal as issued. The conditional UPDATE is the concurrency
 * guard: Postgres row locking means that of two simultaneous requests exactly
 * one sees status = 'pending'; the other matches zero rows and is told who
 * issued it.
 */
export async function issueCoupons(db: Db, actor: Actor | null, raw: unknown): Promise<IssueResult> {
  assertPermission(actor, "distribution:issue");
  const input = parseInput(issueInputSchema, raw);

  return db.transaction(async (tx) => {
    const [updated] = await tx
      .update(distributions)
      .set({
        status: "issued",
        issuedAt: sql`now()`,
        issuedBy: actor.id,
        issueRequestId: input.requestId,
        updatedAt: sql`now()`,
      })
      .where(
        and(
          eq(distributions.teamId, input.teamId),
          eq(distributions.mealType, input.meal),
          eq(distributions.status, "pending"),
          eq(distributions.couponQuantity, input.expectedQuantity),
        ),
      )
      .returning();

    if (updated) {
      const [team] = await tx
        .select({ teamName: teams.teamName, teamCode: teams.teamCode })
        .from(teams)
        .where(eq(teams.id, input.teamId));
      await writeAudit(tx, actor, {
        action: "coupon_issue",
        teamId: input.teamId,
        teamLabel: `${team.teamName} (${team.teamCode})`,
        mealType: input.meal,
        before: { status: "pending" },
        after: {
          status: "issued",
          couponQuantity: updated.couponQuantity,
          issuedAt: updated.issuedAt!.toISOString(),
        },
      });
      return {
        teamId: input.teamId,
        teamName: team.teamName,
        meal: input.meal,
        couponQuantity: updated.couponQuantity,
        issuedAt: updated.issuedAt!.toISOString(),
        issuedByName: actor.name,
        replayed: false,
      };
    }

    // Nothing updated: work out why from the committed state.
    const [current] = await tx
      .select({
        status: distributions.status,
        couponQuantity: distributions.couponQuantity,
        issuedAt: distributions.issuedAt,
        issueRequestId: distributions.issueRequestId,
        issuedByName: users.name,
        teamName: teams.teamName,
      })
      .from(distributions)
      .innerJoin(teams, eq(teams.id, distributions.teamId))
      .leftJoin(users, eq(users.id, distributions.issuedBy))
      .where(and(eq(distributions.teamId, input.teamId), eq(distributions.mealType, input.meal)));

    if (!current) throw new AppError("NOT_FOUND", "Team not found. It may have been removed.");

    if (current.status === "issued") {
      if (current.issueRequestId === input.requestId) {
        return {
          teamId: input.teamId,
          teamName: current.teamName,
          meal: input.meal,
          couponQuantity: current.couponQuantity,
          issuedAt: current.issuedAt!.toISOString(),
          issuedByName: current.issuedByName ?? actor.name,
          replayed: true,
        };
      }
      throw new AppError(
        "ALREADY_ISSUED",
        `${MEAL_LABELS[input.meal]} for ${current.teamName} was already issued by ${current.issuedByName ?? "another organizer"}.`,
        {
          issuedAt: current.issuedAt!.toISOString(),
          issuedByName: current.issuedByName,
          couponQuantity: current.couponQuantity,
        },
      );
    }

    throw new AppError(
      "QUANTITY_CHANGED",
      `The coupon quantity for ${current.teamName} changed to ${current.couponQuantity}. Please review and confirm again.`,
      { couponQuantity: current.couponQuantity },
    );
  });
}

// ---------------------------------------------------------------------------
// Admin corrections
// ---------------------------------------------------------------------------

const reasonSchema = z
  .string()
  .trim()
  .min(5, "Give a reason of at least 5 characters")
  .max(500, "Reason is too long");

export const revertInputSchema = z.object({ teamId: z.uuid(), meal: mealSchema, reason: reasonSchema });

/** Returns an issued meal to pending. The audit log keeps the original issuance. */
export async function revertIssuance(db: Db, actor: Actor | null, raw: unknown) {
  assertPermission(actor, "distribution:correct");
  const input = parseInput(revertInputSchema, raw);

  return db.transaction(async (tx) => {
    const [before] = await tx
      .select({
        id: distributions.id,
        status: distributions.status,
        couponQuantity: distributions.couponQuantity,
        issuedAt: distributions.issuedAt,
        issuedByName: users.name,
        teamName: teams.teamName,
        teamCode: teams.teamCode,
      })
      .from(distributions)
      .innerJoin(teams, eq(teams.id, distributions.teamId))
      .leftJoin(users, eq(users.id, distributions.issuedBy))
      .where(and(eq(distributions.teamId, input.teamId), eq(distributions.mealType, input.meal)))
      .for("update", { of: distributions });
    if (!before) throw new AppError("NOT_FOUND", "Team not found.");
    if (before.status !== "issued") {
      throw new AppError("NOT_ISSUED", `${MEAL_LABELS[input.meal]} has not been issued to ${before.teamName}.`);
    }

    await tx
      .update(distributions)
      .set({ status: "pending", issuedAt: null, issuedBy: null, issueRequestId: null, updatedAt: sql`now()` })
      .where(eq(distributions.id, before.id));

    await writeAudit(tx, actor, {
      action: "coupon_reversal",
      teamId: input.teamId,
      teamLabel: `${before.teamName} (${before.teamCode})`,
      mealType: input.meal,
      reason: input.reason,
      before: {
        status: "issued",
        couponQuantity: before.couponQuantity,
        issuedAt: before.issuedAt?.toISOString() ?? null,
        issuedBy: before.issuedByName,
      },
      after: { status: "pending" },
    });
    return { teamId: input.teamId, meal: input.meal };
  });
}

export const quantityInputSchema = z.object({
  teamId: z.uuid(),
  meal: mealSchema,
  quantity: z.number().int("Quantity must be a whole number").min(1, "Quantity must be at least 1").max(1000),
  reason: reasonSchema,
});

/** Explicit, logged change of one meal's coupon quantity (pending or issued). */
export async function correctCouponQuantity(db: Db, actor: Actor | null, raw: unknown) {
  assertPermission(actor, "distribution:correct");
  const input = parseInput(quantityInputSchema, raw);

  return db.transaction(async (tx) => {
    const [before] = await tx
      .select({
        id: distributions.id,
        status: distributions.status,
        couponQuantity: distributions.couponQuantity,
        teamName: teams.teamName,
        teamCode: teams.teamCode,
      })
      .from(distributions)
      .innerJoin(teams, eq(teams.id, distributions.teamId))
      .where(and(eq(distributions.teamId, input.teamId), eq(distributions.mealType, input.meal)))
      .for("update", { of: distributions });
    if (!before) throw new AppError("NOT_FOUND", "Team not found.");
    if (before.couponQuantity === input.quantity) {
      throw new AppError("VALIDATION", `The quantity is already ${input.quantity}.`);
    }

    await tx
      .update(distributions)
      .set({ couponQuantity: input.quantity, updatedAt: sql`now()` })
      .where(eq(distributions.id, before.id));

    await writeAudit(tx, actor, {
      action: "coupon_quantity_correction",
      teamId: input.teamId,
      teamLabel: `${before.teamName} (${before.teamCode})`,
      mealType: input.meal,
      reason: input.reason,
      before: { couponQuantity: before.couponQuantity, status: before.status },
      after: { couponQuantity: input.quantity, status: before.status },
    });
    return { teamId: input.teamId, meal: input.meal, quantity: input.quantity };
  });
}

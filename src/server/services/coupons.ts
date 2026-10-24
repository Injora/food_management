import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { z } from "zod";

import type { Db, Tx } from "@/db";
import { couponIssuances, participants, teams, users } from "@/db/schema";
import { COUPON_LABELS, COUPON_TYPES, type CouponType } from "@/lib/domain";
import { AppError } from "@/lib/errors";
import { assertPermission, type Actor } from "@/server/auth/permissions";
import { writeAudit } from "./audit";
import { lockActiveTeam, memberSummary, pickMembers } from "./team-lock";
import { parseInput } from "./validation";

/**
 * Entitlement: every active registered member of a team is entitled to one
 * coupon per meal. A partial unique index on (participant, meal) where not
 * reverted makes a second live coupon for the same entitlement impossible,
 * whatever the client does (double clicks, retries, two volunteers at once).
 */

const issueSchema = z
  .object({
    teamId: z.uuid("Invalid team"),
    couponType: z.enum(COUPON_TYPES, { error: "Unknown meal" }),
    participantIds: z.array(z.uuid()).max(100).default([]),
    /** Issue to every member of the team who doesn't have this coupon yet. */
    allPending: z.boolean().default(false),
    /** Generated once per confirmation; a retry with the same id is a replay. */
    requestId: z.uuid(),
  })
  .refine((v) => v.allPending || v.participantIds.length > 0, "Select at least one member");

export type IssueResult = {
  teamId: string;
  couponType: CouponType;
  issuedTo: { id: string; name: string }[];
  skipped: { id: string; name: string; reason: string }[];
  /** Team totals after this request. */
  issued: number;
  entitled: number;
  replayed: boolean;
};

async function teamIssuedCount(tx: Tx, teamId: string, couponType: CouponType, memberIds: string[]) {
  if (memberIds.length === 0) return 0;
  const [{ n }] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(couponIssuances)
    .where(
      and(
        eq(couponIssuances.teamId, teamId),
        eq(couponIssuances.couponType, couponType),
        inArray(couponIssuances.participantId, memberIds),
        isNull(couponIssuances.revertedAt),
      ),
    );
  return n;
}

export async function issueCoupons(db: Db, actor: Actor | null, raw: unknown): Promise<IssueResult> {
  assertPermission(actor, "coupons:issue");
  const input = parseInput(issueSchema, raw);
  const meal = COUPON_LABELS[input.couponType];

  return db.transaction(async (tx) => {
    const { team, members, label } = await lockActiveTeam(tx, input.teamId);
    const memberIds = members.map((m) => m.id);
    const nameOf = new Map(members.map((m) => [m.id, m.name]));

    // A retried request (same id) returns what it did the first time.
    const previous = await tx
      .select({ participantId: couponIssuances.participantId })
      .from(couponIssuances)
      .where(and(eq(couponIssuances.requestId, input.requestId), eq(couponIssuances.teamId, team.id)));
    if (previous.length > 0) {
      return {
        teamId: team.id,
        couponType: input.couponType,
        issuedTo: previous.map((p) => ({ id: p.participantId, name: nameOf.get(p.participantId) ?? "" })),
        skipped: [],
        issued: await teamIssuedCount(tx, team.id, input.couponType, memberIds),
        entitled: members.length,
        replayed: true,
      };
    }

    if (members.length === 0) throw new AppError("VALIDATION", `${team.teamName} has no registered members.`);
    const targets = input.allPending ? members : pickMembers(members, input.participantIds, team.teamName);

    const existing = await tx
      .select({ participantId: couponIssuances.participantId, issuedAt: couponIssuances.issuedAt, issuedBy: users.name })
      .from(couponIssuances)
      .leftJoin(users, eq(users.id, couponIssuances.issuedBy))
      .where(
        and(
          eq(couponIssuances.couponType, input.couponType),
          inArray(couponIssuances.participantId, targets.map((m) => m.id)),
          isNull(couponIssuances.revertedAt),
        ),
      );
    const had = new Map(existing.map((e) => [e.participantId, e]));
    const toIssue = targets.filter((m) => !had.has(m.id));

    if (toIssue.length === 0) {
      const first = existing[0];
      throw new AppError(
        "ALREADY_ISSUED",
        targets.length === 1
          ? `${targets[0].name} already received a ${meal.toLowerCase()} coupon${first?.issuedBy ? ` from ${first.issuedBy}` : ""}.`
          : `Every selected member of ${team.teamName} already has a ${meal.toLowerCase()} coupon.`,
        { issuedAt: first?.issuedAt.toISOString() ?? null, issuedByName: first?.issuedBy ?? null },
      );
    }

    const inserted = await tx
      .insert(couponIssuances)
      .values(
        toIssue.map((m) => ({
          participantId: m.id,
          teamId: team.id,
          couponType: input.couponType,
          issuedBy: actor.id,
          requestId: input.requestId,
        })),
      )
      .onConflictDoNothing({
        target: [couponIssuances.participantId, couponIssuances.couponType],
        where: sql.raw(`"reverted_at" is null`),
      })
      .returning({ participantId: couponIssuances.participantId });
    const insertedIds = new Set(inserted.map((r) => r.participantId));
    const issued = await teamIssuedCount(tx, team.id, input.couponType, memberIds);

    if (insertedIds.size > 0) {
      await writeAudit(tx, actor, {
        action: "coupon_issue",
        teamId: team.id,
        teamLabel: label,
        couponType: input.couponType,
        after: { issued, entitled: members.length, count: insertedIds.size },
        details: { participants: memberSummary(toIssue.filter((m) => insertedIds.has(m.id))), requestId: input.requestId },
      });
    }

    return {
      teamId: team.id,
      couponType: input.couponType,
      issuedTo: toIssue.filter((m) => insertedIds.has(m.id)).map((m) => ({ id: m.id, name: m.name })),
      skipped: targets
        .filter((m) => !insertedIds.has(m.id))
        .map((m) => ({ id: m.id, name: m.name, reason: "already has this coupon" })),
      issued,
      entitled: members.length,
      replayed: false,
    };
  });
}

const revertSchema = z.object({
  issuanceId: z.uuid("Invalid coupon"),
  reason: z.string().trim().min(5, "Give a reason of at least 5 characters").max(500, "Reason is too long"),
});

/** Admin correction: voids one issued coupon. The row is kept, marked reverted. */
export async function revertCoupon(db: Db, actor: Actor | null, raw: unknown) {
  assertPermission(actor, "coupons:revert");
  const input = parseInput(revertSchema, raw);

  return db.transaction(async (tx) => {
    const [row] = await tx
      .select({
        teamId: couponIssuances.teamId,
        couponType: couponIssuances.couponType,
        revertedAt: couponIssuances.revertedAt,
        issuedAt: couponIssuances.issuedAt,
        issuedByName: users.name,
        participantId: participants.id,
        participantName: participants.name,
        participantNo: participants.participantNo,
        teamName: teams.teamName,
        teamCode: teams.teamCode,
      })
      .from(couponIssuances)
      .innerJoin(participants, eq(participants.id, couponIssuances.participantId))
      .innerJoin(teams, eq(teams.id, couponIssuances.teamId))
      .leftJoin(users, eq(users.id, couponIssuances.issuedBy))
      .where(eq(couponIssuances.id, input.issuanceId));
    if (!row) throw new AppError("NOT_FOUND", "Coupon record not found.");

    const updated = await tx
      .update(couponIssuances)
      .set({ revertedAt: sql`now()`, revertedBy: actor.id, revertReason: input.reason })
      .where(and(eq(couponIssuances.id, input.issuanceId), isNull(couponIssuances.revertedAt)))
      .returning({ id: couponIssuances.id });
    if (updated.length === 0) throw new AppError("NOT_ISSUED", "That coupon has already been reverted.");

    await writeAudit(tx, actor, {
      action: "coupon_reversal",
      teamId: row.teamId,
      teamLabel: `${row.teamName} (${row.teamCode})`,
      couponType: row.couponType,
      reason: input.reason,
      before: { issuedAt: row.issuedAt.toISOString(), issuedBy: row.issuedByName },
      after: { status: "reverted" },
      details: { participants: [{ id: row.participantId, name: row.participantName, no: row.participantNo }] },
    });
    return { issuanceId: input.issuanceId, teamId: row.teamId };
  });
}

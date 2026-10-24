import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { z } from "zod";

import type { Db, Tx } from "@/db";
import { checkIns } from "@/db/schema";
import { checkInStatus } from "@/lib/domain";
import { AppError } from "@/lib/errors";
import { assertPermission, type Actor } from "@/server/auth/permissions";
import { writeAudit } from "./audit";
import { lockActiveTeam, memberSummary, pickMembers } from "./team-lock";
import { parseInput } from "./validation";

const checkInSchema = z
  .object({
    teamId: z.uuid("Invalid team"),
    participantIds: z.array(z.uuid()).max(100).default([]),
    /** Explicit "Check in entire team": the volunteer confirmed everyone is here. */
    wholeTeam: z.boolean().default(false),
  })
  .refine((v) => v.wholeTeam || v.participantIds.length > 0, "Select at least one member");

export type CheckInResult = {
  teamId: string;
  checkedIn: string[];
  alreadyPresent: string[];
  present: number;
  size: number;
};

async function presentCount(tx: Tx, teamId: string, memberIds: string[]) {
  if (memberIds.length === 0) return 0;
  const [{ n }] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(checkIns)
    .where(and(eq(checkIns.teamId, teamId), inArray(checkIns.participantId, memberIds), isNull(checkIns.undoneAt)));
  return n;
}

/**
 * Marks the given members present. Idempotent: members who are already
 * checked in are reported, not duplicated (a partial unique index allows only
 * one live check-in per participant).
 */
export async function checkIn(db: Db, actor: Actor | null, raw: unknown): Promise<CheckInResult> {
  assertPermission(actor, "checkin:write");
  const input = parseInput(checkInSchema, raw);

  return db.transaction(async (tx) => {
    const { team, members, label } = await lockActiveTeam(tx, input.teamId);
    if (members.length === 0) throw new AppError("VALIDATION", `${team.teamName} has no registered members.`);
    const targets = input.wholeTeam ? members : pickMembers(members, input.participantIds, team.teamName);

    const inserted = await tx
      .insert(checkIns)
      .values(targets.map((m) => ({ participantId: m.id, teamId: team.id, checkedInBy: actor.id })))
      .onConflictDoNothing({ target: checkIns.participantId, where: sql.raw(`"undone_at" is null`) })
      .returning({ participantId: checkIns.participantId });
    const newIds = new Set(inserted.map((r) => r.participantId));
    const present = await presentCount(tx, team.id, members.map((m) => m.id));

    if (newIds.size > 0) {
      await writeAudit(tx, actor, {
        action: "check_in",
        teamId: team.id,
        teamLabel: label,
        after: { present, size: members.length, status: checkInStatus(present, members.length) },
        details: {
          wholeTeam: input.wholeTeam,
          participants: memberSummary(targets.filter((m) => newIds.has(m.id))),
        },
      });
    }
    return {
      teamId: team.id,
      checkedIn: [...newIds],
      alreadyPresent: targets.filter((m) => !newIds.has(m.id)).map((m) => m.id),
      present,
      size: members.length,
    };
  });
}

const undoSchema = z.object({
  teamId: z.uuid("Invalid team"),
  participantIds: z.array(z.uuid()).min(1, "Select at least one member").max(100),
  reason: z.string().trim().max(500).optional(),
});

/** Reverses accidental check-ins. The original rows stay, marked as undone. */
export async function undoCheckIn(db: Db, actor: Actor | null, raw: unknown): Promise<CheckInResult> {
  assertPermission(actor, "checkin:undo");
  const input = parseInput(undoSchema, raw);

  return db.transaction(async (tx) => {
    const { team, members, label } = await lockActiveTeam(tx, input.teamId);
    const targets = pickMembers(members, input.participantIds, team.teamName);
    const undone = await tx
      .update(checkIns)
      .set({ undoneAt: sql`now()`, undoneBy: actor.id, undoReason: input.reason || null })
      .where(
        and(
          eq(checkIns.teamId, team.id),
          inArray(checkIns.participantId, targets.map((m) => m.id)),
          isNull(checkIns.undoneAt),
        ),
      )
      .returning({ participantId: checkIns.participantId, checkedInAt: checkIns.checkedInAt });
    if (undone.length === 0) throw new AppError("NOT_ISSUED", "Those members are not checked in.");

    const undoneIds = new Set(undone.map((u) => u.participantId));
    const present = await presentCount(tx, team.id, members.map((m) => m.id));
    await writeAudit(tx, actor, {
      action: "check_in_undo",
      teamId: team.id,
      teamLabel: label,
      reason: input.reason || null,
      after: { present, size: members.length, status: checkInStatus(present, members.length) },
      details: { participants: memberSummary(targets.filter((m) => undoneIds.has(m.id))) },
    });
    return { teamId: team.id, checkedIn: [], alreadyPresent: [], present, size: members.length };
  });
}

import { and, asc, eq, isNull, sql } from "drizzle-orm";

import type { Tx } from "@/db";
import { participants, teams, type Participant } from "@/db/schema";
import { AppError } from "@/lib/errors";

/**
 * Locks a team row for the rest of the transaction and returns its active
 * members. Every operation on a team (check-in, coupons, rooms, edits) goes
 * through this, so operations on the same team never interleave.
 */
export async function lockActiveTeam(tx: Tx, teamId: string) {
  const [team] = await tx.select().from(teams).where(eq(teams.id, teamId)).for("no key update");
  if (!team) throw new AppError("NOT_FOUND", "Team not found. It may have been removed.");
  if (team.archivedAt) throw new AppError("CONFLICT", `${team.teamName} is archived. Restore it before making changes.`);
  const members = await tx
    .select()
    .from(participants)
    .where(and(eq(participants.teamId, teamId), isNull(participants.withdrawnAt)))
    .orderBy(sql`${participants.isLeader} desc`, asc(participants.position), asc(participants.participantNo));
  return { team, members, label: `${team.teamName} (${team.teamCode})` };
}

/** Resolves ids to active members of this team, rejecting anyone else. */
export function pickMembers(members: Participant[], ids: string[], teamName: string): Participant[] {
  const byId = new Map(members.map((m) => [m.id, m]));
  const picked: Participant[] = [];
  for (const id of new Set(ids)) {
    const m = byId.get(id);
    if (!m) {
      throw new AppError(
        "VALIDATION",
        `One of the selected people is not an active member of ${teamName}. Refresh and try again.`,
      );
    }
    picked.push(m);
  }
  return picked;
}

export const memberSummary = (list: Pick<Participant, "id" | "name" | "participantNo">[]) =>
  list.map((m) => ({ id: m.id, name: m.name, no: m.participantNo }));

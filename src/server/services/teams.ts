import { and, count, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";

import type { Db } from "@/db";
import { checkIns, couponIssuances, participants, roomAllocations, teamRoomAssignments, teams } from "@/db/schema";
import { AppError } from "@/lib/errors";
import {
  deriveTeamCode,
  looksLikeEmail,
  normalizeEmail,
  normalizeKey,
  participantIdentity,
  teamRegistrationKey,
} from "@/lib/registration-import";
import { assertPermission, type Actor } from "@/server/auth/permissions";
import { listAudit, writeAudit } from "./audit";
import { releaseParticipantsInTx } from "./rooms";
import { lockActiveTeam } from "./team-lock";
import { isUniqueViolation, parseInput } from "./validation";

const reasonSchema = z.string().trim().min(5, "Give a reason of at least 5 characters").max(500, "Reason is too long");

const personSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(120, "Name is too long"),
  email: z
    .string()
    .trim()
    .max(254)
    .optional()
    .default("")
    .refine((v) => v === "" || looksLikeEmail(v), "Enter a valid email address or leave it blank"),
  phone: z.string().trim().max(40).optional().default(""),
});

export async function getTeamHistory(db: Db, actor: Actor | null, teamId: string) {
  assertPermission(actor, "teams:view");
  if (!z.uuid().safeParse(teamId).success) throw new AppError("NOT_FOUND", "Team not found.");
  return (await listAudit(db, actor, { teamId, limit: 200 })).rows;
}

// ---------------------------------------------------------------------------
// Teams
// ---------------------------------------------------------------------------

const createTeamSchema = z.object({
  teamName: z.string().trim().min(1, "Team name is required").max(120, "Team name is too long"),
  college: z.string().trim().max(200).optional().default(""),
  members: z.array(personSchema).min(1, "Add at least one member").max(20),
  /** Index into members of the team leader. */
  leaderIndex: z.number().int().min(0).default(0),
});

/** Walk-in registration at the desk (admin). */
export async function createTeam(db: Db, actor: Actor | null, raw: unknown) {
  assertPermission(actor, "teams:edit");
  const input = parseInput(createTeamSchema, raw);
  if (input.leaderIndex >= input.members.length) throw new AppError("VALIDATION", "Choose the team leader.");
  const teamNameKey = normalizeKey(input.teamName);
  if (!teamNameKey) throw new AppError("VALIDATION", "Team name must contain letters or digits.");
  const leader = input.members[input.leaderIndex];
  const members = input.members.map((m, i) => ({
    name: m.name,
    email: normalizeEmail(m.email),
    phone: m.phone || null,
    isLeader: i === input.leaderIndex,
    position: i,
  }));
  const keys = members.map((m) => participantIdentity(m));
  if (new Set(keys).size !== keys.length) throw new AppError("VALIDATION", "The same person is listed twice.");

  try {
    return await db.transaction(async (tx) => {
      const taken = new Set((await tx.select({ code: teams.teamCode }).from(teams)).map((r) => r.code));
      const base = deriveTeamCode(input.teamName);
      let code = base;
      for (let n = 2; taken.has(code); n++) code = `${base}-${n}`;
      const [team] = await tx
        .insert(teams)
        .values({
          teamCode: code,
          teamName: input.teamName,
          teamNameKey,
          registrationKey: teamRegistrationKey({ teamNameKey, leaderEmail: normalizeEmail(leader.email), leaderPhone: leader.phone || null, leaderName: leader.name }),
          college: input.college || null,
          source: { createdManually: true },
        })
        .returning({ id: teams.id });
      await tx.insert(participants).values(members.map((m, i) => ({ ...m, teamId: team.id, identityKey: keys[i] })));
      await writeAudit(tx, actor, {
        action: "team_create",
        teamId: team.id,
        teamLabel: `${input.teamName} (${code})`,
        after: { teamName: input.teamName, college: input.college || null, members: members.map((m) => m.name) },
      });
      return { teamId: team.id, teamCode: code };
    });
  } catch (err) {
    if (isUniqueViolation(err, "teams_registration_key_unique")) {
      throw new AppError("CONFLICT", "This team (same name and leader) is already registered.");
    }
    throw err;
  }
}

const updateTeamSchema = z.object({
  teamId: z.uuid(),
  teamName: createTeamSchema.shape.teamName,
  college: createTeamSchema.shape.college,
});

export async function updateTeam(db: Db, actor: Actor | null, raw: unknown) {
  assertPermission(actor, "teams:edit");
  const input = parseInput(updateTeamSchema, raw);
  const teamNameKey = normalizeKey(input.teamName);
  if (!teamNameKey) throw new AppError("VALIDATION", "Team name must contain letters or digits.");
  return db.transaction(async (tx) => {
    const { team } = await lockActiveTeam(tx, input.teamId);
    const before: Record<string, unknown> = {};
    const after: Record<string, unknown> = {};
    if (team.teamName !== input.teamName) [before.teamName, after.teamName] = [team.teamName, input.teamName];
    if ((team.college ?? "") !== input.college) [before.college, after.college] = [team.college, input.college || null];
    if (Object.keys(after).length === 0) return { teamId: team.id, changed: false };
    await tx
      .update(teams)
      .set({ teamName: input.teamName, teamNameKey, college: input.college || null, updatedAt: new Date() })
      .where(eq(teams.id, team.id));
    await writeAudit(tx, actor, { action: "team_update", teamId: team.id, teamLabel: `${input.teamName} (${team.teamCode})`, before, after });
    return { teamId: team.id, changed: true };
  });
}

const teamReasonSchema = z.object({ teamId: z.uuid(), reason: reasonSchema });

/**
 * Removes a team from operations. Its room seats are released; check-ins,
 * coupons and the audit trail are kept. Fully reversible.
 */
export async function archiveTeam(db: Db, actor: Actor | null, raw: unknown) {
  assertPermission(actor, "teams:edit");
  const input = parseInput(teamReasonSchema, raw);
  return db.transaction(async (tx) => {
    const { team, members, label } = await lockActiveTeam(tx, input.teamId);
    const released = await releaseParticipantsInTx(tx, members.map((m) => m.id));
    await tx.update(teams).set({ archivedAt: new Date(), archivedReason: input.reason, updatedAt: new Date() }).where(eq(teams.id, team.id));
    await writeAudit(tx, actor, {
      action: "team_archive",
      teamId: team.id,
      teamLabel: label,
      reason: input.reason,
      after: { archived: true },
      details: { roomSeatsReleased: released },
    });
    return { teamId: team.id };
  });
}

export async function restoreTeam(db: Db, actor: Actor | null, raw: unknown) {
  assertPermission(actor, "teams:edit");
  const { teamId } = parseInput(z.object({ teamId: z.uuid() }), raw);
  return db.transaction(async (tx) => {
    const [team] = await tx.select().from(teams).where(eq(teams.id, teamId)).for("update");
    if (!team) throw new AppError("NOT_FOUND", "Team not found.");
    if (!team.archivedAt) return { teamId };
    await tx.update(teams).set({ archivedAt: null, archivedReason: null, updatedAt: new Date() }).where(eq(teams.id, teamId));
    await writeAudit(tx, actor, { action: "team_update", teamId, teamLabel: `${team.teamName} (${team.teamCode})`, before: { archived: true }, after: { archived: false } });
    return { teamId };
  });
}

/**
 * Permanently deletes a team created by mistake. Refused once it has any
 * operational record (check-in, coupon or room history); archive it instead.
 */
export async function deleteTeam(db: Db, actor: Actor | null, raw: unknown) {
  assertPermission(actor, "teams:edit");
  const input = parseInput(teamReasonSchema, raw);
  return db.transaction(async (tx) => {
    const [team] = await tx.select().from(teams).where(eq(teams.id, input.teamId)).for("update");
    if (!team) throw new AppError("NOT_FOUND", "Team not found.");
    const [[c], [k], [r], [a]] = await Promise.all([
      tx.select({ n: count() }).from(checkIns).where(eq(checkIns.teamId, team.id)),
      tx.select({ n: count() }).from(couponIssuances).where(eq(couponIssuances.teamId, team.id)),
      tx.select({ n: count() }).from(roomAllocations).where(eq(roomAllocations.teamId, team.id)),
      tx.select({ n: count() }).from(teamRoomAssignments).where(eq(teamRoomAssignments.teamId, team.id)),
    ]);
    if (c.n + k.n + r.n + a.n > 0) {
      throw new AppError("CONFLICT", `${team.teamName} has check-in, coupon or room records, so it can't be deleted. Archive it instead.`);
    }
    const members = await tx.select({ name: participants.name }).from(participants).where(eq(participants.teamId, team.id));
    await writeAudit(tx, actor, {
      action: "team_delete",
      teamId: team.id,
      teamLabel: `${team.teamName} (${team.teamCode})`,
      reason: input.reason,
      before: { teamName: team.teamName, teamCode: team.teamCode, college: team.college, members: members.map((m) => m.name) },
    });
    await tx.delete(participants).where(eq(participants.teamId, team.id));
    await tx.delete(teams).where(eq(teams.id, team.id));
    return { teamId: team.id };
  });
}

// ---------------------------------------------------------------------------
// Participants
// ---------------------------------------------------------------------------

const addParticipantSchema = personSchema.extend({ teamId: z.uuid(), isLeader: z.boolean().default(false) });

export async function addParticipant(db: Db, actor: Actor | null, raw: unknown) {
  assertPermission(actor, "teams:edit");
  const input = parseInput(addParticipantSchema, raw);
  try {
    return await db.transaction(async (tx) => {
      const { team, members, label } = await lockActiveTeam(tx, input.teamId);
      const email = normalizeEmail(input.email);
      const person = { name: input.name, email, phone: input.phone || null };
      if (input.isLeader) await tx.update(participants).set({ isLeader: false }).where(and(eq(participants.teamId, team.id), eq(participants.isLeader, true)));
      const [created] = await tx
        .insert(participants)
        .values({
          ...person,
          teamId: team.id,
          identityKey: participantIdentity(person),
          isLeader: input.isLeader,
          position: members.length,
          source: { addedManually: true },
        })
        .returning({ id: participants.id });
      await writeAudit(tx, actor, { action: "participant_create", teamId: team.id, teamLabel: label, after: { ...person, isLeader: input.isLeader } });
      return { participantId: created.id };
    });
  } catch (err) {
    if (isUniqueViolation(err, "participants_team_identity_unique")) {
      throw new AppError("CONFLICT", "This person is already a member of the team (same email, phone or name).");
    }
    throw err;
  }
}

const updateParticipantSchema = personSchema.extend({ participantId: z.uuid(), isLeader: z.boolean() });

export async function updateParticipant(db: Db, actor: Actor | null, raw: unknown) {
  assertPermission(actor, "teams:edit");
  const input = parseInput(updateParticipantSchema, raw);
  return db.transaction(async (tx) => {
    const [p] = await tx.select().from(participants).where(eq(participants.id, input.participantId));
    if (!p) throw new AppError("NOT_FOUND", "Participant not found.");
    const { label } = await lockActiveTeam(tx, p.teamId);
    const next = { name: input.name, email: normalizeEmail(input.email), phone: input.phone || null, isLeader: input.isLeader };
    const before: Record<string, unknown> = {};
    const after: Record<string, unknown> = {};
    for (const k of ["name", "email", "phone", "isLeader"] as const) {
      if (p[k] !== next[k]) [before[k], after[k]] = [p[k], next[k]];
    }
    if (Object.keys(after).length === 0) return { participantId: p.id, changed: false };
    if (next.isLeader && !p.isLeader) {
      await tx.update(participants).set({ isLeader: false }).where(and(eq(participants.teamId, p.teamId), eq(participants.isLeader, true)));
    }
    await tx.update(participants).set({ ...next, updatedAt: new Date() }).where(eq(participants.id, p.id));
    await writeAudit(tx, actor, { action: "participant_update", teamId: p.teamId, teamLabel: label, before, after, details: { participant: p.name } });
    return { participantId: p.id, changed: true };
  });
}

const withdrawSchema = z.object({ participantId: z.uuid(), reason: reasonSchema });

/**
 * Takes a member off the team's active list (no-show, registered in another
 * team, …). Their room seats are released; check-in and coupon history stays.
 */
export async function withdrawParticipant(db: Db, actor: Actor | null, raw: unknown) {
  assertPermission(actor, "teams:edit");
  const input = parseInput(withdrawSchema, raw);
  return db.transaction(async (tx) => {
    const [p] = await tx.select().from(participants).where(eq(participants.id, input.participantId));
    if (!p) throw new AppError("NOT_FOUND", "Participant not found.");
    const { label } = await lockActiveTeam(tx, p.teamId);
    if (p.withdrawnAt) throw new AppError("CONFLICT", `${p.name} is already withdrawn.`);
    const released = await releaseParticipantsInTx(tx, [p.id]);
    await tx.update(participants).set({ withdrawnAt: new Date(), isLeader: false, updatedAt: new Date() }).where(eq(participants.id, p.id));
    await writeAudit(tx, actor, {
      action: "participant_withdraw",
      teamId: p.teamId,
      teamLabel: label,
      reason: input.reason,
      details: { participant: p.name, wasLeader: p.isLeader, roomSeatsReleased: released },
    });
    return { participantId: p.id };
  });
}

export async function restoreParticipant(db: Db, actor: Actor | null, raw: unknown) {
  assertPermission(actor, "teams:edit");
  const { participantId } = parseInput(z.object({ participantId: z.uuid() }), raw);
  return db.transaction(async (tx) => {
    const [p] = await tx.select().from(participants).where(eq(participants.id, participantId));
    if (!p) throw new AppError("NOT_FOUND", "Participant not found.");
    const { label } = await lockActiveTeam(tx, p.teamId);
    if (!p.withdrawnAt) return { participantId };
    await tx.update(participants).set({ withdrawnAt: null, updatedAt: new Date() }).where(eq(participants.id, p.id));
    await writeAudit(tx, actor, { action: "participant_update", teamId: p.teamId, teamLabel: label, before: { withdrawn: true }, after: { withdrawn: false }, details: { participant: p.name } });
    return { participantId };
  });
}

/** Archived teams, for the Teams page. */
export async function listArchivedTeams(db: Db, actor: Actor | null) {
  assertPermission(actor, "teams:view");
  const rows = await db
    .select({ id: teams.id, teamName: teams.teamName, teamCode: teams.teamCode, archivedAt: teams.archivedAt, reason: teams.archivedReason })
    .from(teams)
    .where(sql`${teams.archivedAt} is not null`)
    .orderBy(teams.teamName);
  return rows.map((r) => ({ ...r, archivedAt: r.archivedAt!.toISOString() }));
}

/** Count of active members (used by tests and reports). */
export async function activeMemberCount(db: Db, teamId: string) {
  const [{ n }] = await db
    .select({ n: count() })
    .from(participants)
    .where(and(eq(participants.teamId, teamId), isNull(participants.withdrawnAt)));
  return n;
}

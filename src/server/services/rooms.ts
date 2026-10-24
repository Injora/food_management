import { and, asc, eq, inArray } from "drizzle-orm";
import { z } from "zod";

import type { Db, Tx } from "@/db";
import { eventSessions, roomAllocations, rooms, teamRoomAssignments, type Room } from "@/db/schema";
import { capacityErrorMessage, effectiveMax, evaluateFit, isLimited, suggestRooms, type FitDecision } from "@/lib/capacity";
import { SESSION_IDS, SESSION_LABELS, type SessionId } from "@/lib/domain";
import { AppError } from "@/lib/errors";
import { assertPermission, type Actor } from "@/server/auth/permissions";
import { writeAudit } from "./audit";
import { lockActiveTeam, memberSummary, pickMembers } from "./team-lock";
import { parseInput, pgError } from "./validation";

/**
 * Capacity is counted in participants. Every allocation change runs in one
 * transaction that:
 *   1. locks the team (so one team's changes never interleave),
 *   2. locks the affected room rows FOR UPDATE, in id order (no deadlocks),
 *   3. checks occupancy + incoming ≤ nominal + tolerance against the locked row,
 *   4. writes participant allocation rows; a trigger updates rooms.occupancy,
 *      and a CHECK constraint on rooms rejects anything over the limit.
 * Step 3 gives the friendly error; step 4 is the guarantee.
 */

const sessionSchema = z.enum(SESSION_IDS, { error: "Unknown session" });

export type AlternativeRoom = {
  roomId: string;
  roomNumber: string;
  occupancy: number;
  nominalCapacity: number | null;
  overflowTolerance: number;
  decision: Exclude<FitDecision, "reject">;
};

export type CapacityErrorDetails = {
  roomId: string;
  roomNumber: string;
  occupancy: number;
  nominalCapacity: number;
  overflowTolerance: number;
  effectiveMax: number;
  requested: number;
  projected: number;
  alternatives: AlternativeRoom[];
};

async function lockRooms(tx: Tx, roomIds: string[]): Promise<Map<string, Room>> {
  const ids = [...new Set(roomIds)].sort();
  const locked = await tx.select().from(rooms).where(inArray(rooms.id, ids)).orderBy(asc(rooms.id)).for("update");
  return new Map(locked.map((r) => [r.id, r]));
}

/** Only called for limited rooms: unlimited (talk) rooms never reject. */
async function capacityError(tx: Tx, room: Room & { nominalCapacity: number }, requested: number): Promise<AppError> {
  const all = await tx.select().from(rooms).where(eq(rooms.sessionId, room.sessionId));
  const alternatives = suggestRooms(all, requested, room.id).map(({ room: r, decision }) => ({
    roomId: r.id,
    roomNumber: r.roomNumber,
    occupancy: r.occupancy,
    nominalCapacity: r.nominalCapacity,
    overflowTolerance: r.overflowTolerance,
    decision,
  }));
  const { title, message } = capacityErrorMessage(room.roomNumber, room.overflowTolerance);
  const details: CapacityErrorDetails = {
    roomId: room.id,
    roomNumber: room.roomNumber,
    occupancy: room.occupancy,
    nominalCapacity: room.nominalCapacity,
    overflowTolerance: room.overflowTolerance,
    effectiveMax: effectiveMax(room),
    requested,
    projected: room.occupancy + requested,
    alternatives,
  };
  return new AppError("CAPACITY_EXCEEDED", `${title} ${message}`, details);
}

/** Last line of defence: the CHECK constraint fired even though we checked first. */
function isCapacityViolation(err: unknown) {
  const e = pgError(err);
  return e?.code === "23514" && e.constraint === "rooms_occupancy_within_limit";
}

async function getAssignment(tx: Tx, sessionId: SessionId, teamId: string) {
  const [row] = await tx
    .select()
    .from(teamRoomAssignments)
    .where(and(eq(teamRoomAssignments.sessionId, sessionId), eq(teamRoomAssignments.teamId, teamId)));
  return row ?? null;
}

async function teamAllocations(tx: Tx, sessionId: SessionId, teamId: string) {
  return tx
    .select({ participantId: roomAllocations.participantId, roomId: roomAllocations.roomId })
    .from(roomAllocations)
    .where(and(eq(roomAllocations.sessionId, sessionId), eq(roomAllocations.teamId, teamId)));
}

export type AllocationResult = {
  sessionId: SessionId;
  teamId: string;
  roomId: string;
  roomNumber: string;
  added: number;
  teamAllocated: number;
  occupancy: number;
  /** Null for rooms without a capacity limit (open-source talks). */
  nominalCapacity: number | null;
  overflowTolerance: number;
  /** True when the room is now above nominal capacity (within the tolerance). */
  overNominal: boolean;
};

const allocateSchema = z.object({
  sessionId: sessionSchema,
  teamId: z.uuid("Invalid team"),
  roomId: z.uuid("Choose a room"),
  participantIds: z.array(z.uuid()).min(1, "Select at least one member to allocate").max(100),
});

/**
 * Seats the selected members of a team in a room. A team occupies one room
 * per session: further calls can add more members to that room, but moving
 * to another room is an explicit reassignment (moveTeam).
 */
export async function allocateTeam(db: Db, actor: Actor | null, raw: unknown): Promise<AllocationResult> {
  assertPermission(actor, "rooms:allocate");
  const input = parseInput(allocateSchema, raw);

  try {
    return await db.transaction(async (tx) => {
      const { team, members, label } = await lockActiveTeam(tx, input.teamId);
      const targets = pickMembers(members, input.participantIds, team.teamName);

      const assignment = await getAssignment(tx, input.sessionId, team.id);
      const lockedRooms = await lockRooms(tx, assignment ? [input.roomId, assignment.roomId] : [input.roomId]);
      const room = lockedRooms.get(input.roomId);
      if (!room || room.sessionId !== input.sessionId) {
        throw new AppError("VALIDATION", `That room is not part of the ${SESSION_LABELS[input.sessionId]} session.`);
      }
      if (assignment && assignment.roomId !== room.id) {
        const current = lockedRooms.get(assignment.roomId);
        throw new AppError(
          "ALREADY_ASSIGNED",
          `${team.teamName} is already allocated to Room ${current?.roomNumber ?? "?"} for ${SESSION_LABELS[input.sessionId]}. Use "Move" to reassign the team.`,
          { roomId: assignment.roomId, roomNumber: current?.roomNumber ?? null },
        );
      }

      const existing = await teamAllocations(tx, input.sessionId, team.id);
      const seated = new Set(existing.map((a) => a.participantId));
      const incoming = targets.filter((m) => !seated.has(m.id));

      if (incoming.length > 0) {
        const { decision, projected } = evaluateFit(room, incoming.length);
        if (decision === "reject" && isLimited(room)) throw await capacityError(tx, room, incoming.length);

        if (!assignment) {
          await tx.insert(teamRoomAssignments).values({ sessionId: input.sessionId, teamId: team.id, roomId: room.id, assignedBy: actor.id });
        }
        await tx.insert(roomAllocations).values(
          incoming.map((m) => ({ sessionId: input.sessionId, roomId: room.id, teamId: team.id, participantId: m.id, allocatedBy: actor.id })),
        );
        await writeAudit(tx, actor, {
          action: "room_assign",
          teamId: team.id,
          teamLabel: label,
          sessionId: input.sessionId,
          before: { room: assignment ? room.roomNumber : null, teamAllocated: existing.length, occupancy: room.occupancy },
          after: {
            room: room.roomNumber,
            teamAllocated: existing.length + incoming.length,
            occupancy: projected,
            nominalCapacity: room.nominalCapacity,
            overflowTolerance: room.overflowTolerance,
          },
          details: { participants: memberSummary(incoming), overNominal: decision === "overflow" },
        });
      }

      const [after] = await tx.select().from(rooms).where(eq(rooms.id, room.id));
      return {
        sessionId: input.sessionId,
        teamId: team.id,
        roomId: room.id,
        roomNumber: room.roomNumber,
        added: incoming.length,
        teamAllocated: existing.length + incoming.length,
        occupancy: after.occupancy,
        nominalCapacity: after.nominalCapacity,
        overflowTolerance: after.overflowTolerance,
        overNominal: after.nominalCapacity !== null && after.occupancy > after.nominalCapacity,
      };
    });
  } catch (err) {
    if (isCapacityViolation(err)) {
      throw new AppError("CAPACITY_EXCEEDED", "Maximum capacity reached for this room. Please allocate this team to another room.");
    }
    throw err;
  }
}

const moveSchema = z.object({
  sessionId: sessionSchema,
  teamId: z.uuid("Invalid team"),
  toRoomId: z.uuid("Choose a room"),
  /** Members to seat in the new room; defaults to everyone currently seated. */
  participantIds: z.array(z.uuid()).min(1).max(100).optional(),
});

/**
 * Reassigns a team to another room in the same session. The old seats are
 * released and the new ones taken in one transaction, so occupancy is never
 * double counted and a rejected move leaves the team where it was.
 */
export async function moveTeam(db: Db, actor: Actor | null, raw: unknown): Promise<AllocationResult> {
  assertPermission(actor, "rooms:reassign");
  const input = parseInput(moveSchema, raw);

  try {
    return await db.transaction(async (tx) => {
      const { team, members, label } = await lockActiveTeam(tx, input.teamId);
      const assignment = await getAssignment(tx, input.sessionId, team.id);
      if (!assignment) {
        throw new AppError("VALIDATION", `${team.teamName} has no room for ${SESSION_LABELS[input.sessionId]} yet. Allocate it first.`);
      }
      if (assignment.roomId === input.toRoomId) throw new AppError("VALIDATION", `${team.teamName} is already in that room.`);

      const lockedRooms = await lockRooms(tx, [assignment.roomId, input.toRoomId]);
      const from = lockedRooms.get(assignment.roomId)!;
      const to = lockedRooms.get(input.toRoomId);
      if (!to || to.sessionId !== input.sessionId) {
        throw new AppError("VALIDATION", `That room is not part of the ${SESSION_LABELS[input.sessionId]} session.`);
      }

      const existing = await teamAllocations(tx, input.sessionId, team.id);
      const memberById = new Map(members.map((m) => [m.id, m]));
      const moving = input.participantIds
        ? pickMembers(members, input.participantIds, team.teamName)
        : existing.map((a) => memberById.get(a.participantId)).filter((m) => m !== undefined);
      if (moving.length === 0) throw new AppError("VALIDATION", "Select at least one member to move.");

      // The destination is checked on its own locked row; releasing the old
      // room never frees space in the new one.
      const { decision, projected } = evaluateFit(to, moving.length);
      if (decision === "reject" && isLimited(to)) throw await capacityError(tx, to, moving.length);

      await tx.delete(roomAllocations).where(and(eq(roomAllocations.sessionId, input.sessionId), eq(roomAllocations.teamId, team.id)));
      await tx
        .update(teamRoomAssignments)
        .set({ roomId: to.id, assignedAt: new Date(), assignedBy: actor.id })
        .where(eq(teamRoomAssignments.id, assignment.id));
      await tx.insert(roomAllocations).values(
        moving.map((m) => ({ sessionId: input.sessionId, roomId: to.id, teamId: team.id, participantId: m.id, allocatedBy: actor.id })),
      );

      await writeAudit(tx, actor, {
        action: "room_move",
        teamId: team.id,
        teamLabel: label,
        sessionId: input.sessionId,
        before: { room: from.roomNumber, teamAllocated: existing.length, roomOccupancy: from.occupancy },
        after: { room: to.roomNumber, teamAllocated: moving.length, roomOccupancy: projected },
        details: { participants: memberSummary(moving), overNominal: decision === "overflow" },
      });

      const [after] = await tx.select().from(rooms).where(eq(rooms.id, to.id));
      return {
        sessionId: input.sessionId,
        teamId: team.id,
        roomId: to.id,
        roomNumber: to.roomNumber,
        added: moving.length,
        teamAllocated: moving.length,
        occupancy: after.occupancy,
        nominalCapacity: after.nominalCapacity,
        overflowTolerance: after.overflowTolerance,
        overNominal: after.nominalCapacity !== null && after.occupancy > after.nominalCapacity,
      };
    });
  } catch (err) {
    if (isCapacityViolation(err)) {
      throw new AppError("CAPACITY_EXCEEDED", "Maximum capacity reached for the destination room. Please choose another room.");
    }
    throw err;
  }
}

const releaseSchema = z.object({
  sessionId: sessionSchema,
  teamId: z.uuid("Invalid team"),
  /** Only these members; omit to release the whole team. */
  participantIds: z.array(z.uuid()).min(1).max(100).optional(),
  reason: z.string().trim().max(500).optional(),
});

/** Frees seats. The team keeps its room until its last member is released. */
export async function releaseAllocation(db: Db, actor: Actor | null, raw: unknown) {
  assertPermission(actor, "rooms:reassign");
  const input = parseInput(releaseSchema, raw);

  return db.transaction(async (tx) => {
    const { team, label } = await lockActiveTeam(tx, input.teamId);
    const assignment = await getAssignment(tx, input.sessionId, team.id);
    if (!assignment) throw new AppError("VALIDATION", `${team.teamName} has no room for ${SESSION_LABELS[input.sessionId]}.`);
    const lockedRooms = await lockRooms(tx, [assignment.roomId]);
    const room = lockedRooms.get(assignment.roomId)!;

    const where = and(
      eq(roomAllocations.sessionId, input.sessionId),
      eq(roomAllocations.teamId, team.id),
      input.participantIds ? inArray(roomAllocations.participantId, input.participantIds) : undefined,
    );
    const released = await tx.delete(roomAllocations).where(where).returning({ participantId: roomAllocations.participantId });
    const remaining = await teamAllocations(tx, input.sessionId, team.id);
    if (remaining.length === 0) await tx.delete(teamRoomAssignments).where(eq(teamRoomAssignments.id, assignment.id));

    await writeAudit(tx, actor, {
      action: "room_release",
      teamId: team.id,
      teamLabel: label,
      sessionId: input.sessionId,
      reason: input.reason || null,
      before: { room: room.roomNumber, teamAllocated: remaining.length + released.length, occupancy: room.occupancy },
      after: { room: remaining.length > 0 ? room.roomNumber : null, teamAllocated: remaining.length, occupancy: room.occupancy - released.length },
      details: { participantIds: released.map((r) => r.participantId) },
    });
    return { teamId: team.id, released: released.length, remaining: remaining.length };
  });
}

/** Used when a member withdraws or a team is archived. Caller holds the team lock. */
export async function releaseParticipantsInTx(tx: Tx, participantIds: string[]) {
  if (participantIds.length === 0) return 0;
  const released = await tx
    .delete(roomAllocations)
    .where(inArray(roomAllocations.participantId, participantIds))
    .returning({ sessionId: roomAllocations.sessionId, teamId: roomAllocations.teamId });
  // Drop team assignments left with nobody seated.
  for (const key of new Set(released.map((r) => `${r.sessionId}|${r.teamId}`))) {
    const [sessionId, teamId] = key.split("|") as [SessionId, string];
    const left = await teamAllocations(tx, sessionId, teamId);
    if (left.length === 0) {
      await tx
        .delete(teamRoomAssignments)
        .where(and(eq(teamRoomAssignments.sessionId, sessionId), eq(teamRoomAssignments.teamId, teamId)));
    }
  }
  return released.length;
}

// ---------------------------------------------------------------------------
// Settings (admin)
// ---------------------------------------------------------------------------

const capacitySchema = z.number().int("Capacity must be a whole number").min(1, "Capacity must be at least 1").max(10_000).nullable();

/** Session-specific configuration: talk rooms are unlimited, hackathon rooms are not. */
function checkCapacityForSession(sessionId: SessionId, nominalCapacity: number | null) {
  if (sessionId === "talks" && nominalCapacity !== null) {
    throw new AppError("VALIDATION", "Open-source talk rooms have no capacity limit.");
  }
  if (sessionId === "hackathon" && nominalCapacity === null) {
    throw new AppError("VALIDATION", "Hackathon rooms need a capacity.");
  }
}

const roomUpdateSchema = z.object({
  roomId: z.uuid(),
  nominalCapacity: capacitySchema,
  overflowTolerance: z.number().int("Tolerance must be a whole number").min(0, "Tolerance can't be negative").max(50),
});

/**
 * Changes a room's nominal capacity or tolerance. Refused if the room already
 * holds more people than the new limit: occupancy is never hidden by quietly
 * raising or lowering numbers.
 */
export async function updateRoom(db: Db, actor: Actor | null, raw: unknown) {
  assertPermission(actor, "rooms:configure");
  const input = parseInput(roomUpdateSchema, raw);
  return db.transaction(async (tx) => {
    const room = (await lockRooms(tx, [input.roomId])).get(input.roomId);
    if (!room) throw new AppError("NOT_FOUND", "Room not found.");
    checkCapacityForSession(room.sessionId, input.nominalCapacity);
    if (input.nominalCapacity !== null && room.occupancy > input.nominalCapacity + input.overflowTolerance) {
      throw new AppError(
        "CONFLICT",
        `Room ${room.roomNumber} currently holds ${room.occupancy} participants, more than ${input.nominalCapacity} + ${input.overflowTolerance}. Move teams out first.`,
      );
    }
    if (room.nominalCapacity === input.nominalCapacity && room.overflowTolerance === input.overflowTolerance) {
      return { roomId: room.id, changed: false };
    }
    await tx
      .update(rooms)
      .set({ nominalCapacity: input.nominalCapacity, overflowTolerance: input.overflowTolerance, updatedAt: new Date() })
      .where(eq(rooms.id, room.id));
    await writeAudit(tx, actor, {
      action: "room_update",
      sessionId: room.sessionId,
      before: { room: room.roomNumber, nominalCapacity: room.nominalCapacity, overflowTolerance: room.overflowTolerance },
      after: { room: room.roomNumber, nominalCapacity: input.nominalCapacity, overflowTolerance: input.overflowTolerance },
    });
    return { roomId: room.id, changed: true };
  });
}

const sessionUpdateSchema = z
  .object({
    sessionId: sessionSchema,
    name: z.string().trim().min(1, "Name is required").max(120),
    startsAt: z.iso.datetime({ offset: true, error: "Enter a valid start time" }),
    endsAt: z.iso.datetime({ offset: true, error: "Enter a valid end time" }),
    /** Applied to every room of the session. */
    overflowTolerance: z.number().int().min(0, "Tolerance can't be negative").max(50),
  })
  .refine((v) => new Date(v.endsAt) > new Date(v.startsAt), { message: "The session must end after it starts", path: ["endsAt"] });

export async function updateSession(db: Db, actor: Actor | null, raw: unknown) {
  assertPermission(actor, "rooms:configure");
  const input = parseInput(sessionUpdateSchema, raw);
  return db.transaction(async (tx) => {
    const [session] = await tx.select().from(eventSessions).where(eq(eventSessions.id, input.sessionId)).for("update");
    if (!session) throw new AppError("NOT_FOUND", "Session not found.");
    const sessionRooms = await tx.select().from(rooms).where(eq(rooms.sessionId, input.sessionId)).orderBy(asc(rooms.id)).for("update");
    const tooFull = sessionRooms.filter((r) => r.nominalCapacity !== null && r.occupancy > r.nominalCapacity + input.overflowTolerance);
    if (tooFull.length > 0) {
      throw new AppError(
        "CONFLICT",
        `Can't set the tolerance to ${input.overflowTolerance}: ${tooFull.map((r) => `Room ${r.roomNumber} holds ${r.occupancy}/${r.nominalCapacity}`).join(", ")}. Move teams out first.`,
      );
    }
    await tx
      .update(eventSessions)
      .set({ name: input.name, startsAt: new Date(input.startsAt), endsAt: new Date(input.endsAt), updatedAt: new Date() })
      .where(eq(eventSessions.id, input.sessionId));
    await tx.update(rooms).set({ overflowTolerance: input.overflowTolerance, updatedAt: new Date() }).where(eq(rooms.sessionId, input.sessionId));
    await writeAudit(tx, actor, {
      action: "session_update",
      sessionId: input.sessionId,
      before: {
        name: session.name,
        startsAt: session.startsAt.toISOString(),
        endsAt: session.endsAt.toISOString(),
        overflowTolerance: [...new Set(sessionRooms.map((r) => r.overflowTolerance))].join("/"),
      },
      after: { name: input.name, startsAt: input.startsAt, endsAt: input.endsAt, overflowTolerance: input.overflowTolerance },
    });
    return { sessionId: input.sessionId };
  });
}

const roomCreateSchema = z.object({
  sessionId: sessionSchema,
  roomNumber: z.string().trim().min(1, "Room number is required").max(40),
  nominalCapacity: roomUpdateSchema.shape.nominalCapacity,
  overflowTolerance: roomUpdateSchema.shape.overflowTolerance,
});

export async function createRoom(db: Db, actor: Actor | null, raw: unknown) {
  assertPermission(actor, "rooms:configure");
  const input = parseInput(roomCreateSchema, raw);
  checkCapacityForSession(input.sessionId, input.nominalCapacity);
  return db.transaction(async (tx) => {
    const existing = await tx.select({ roomNumber: rooms.roomNumber, sortOrder: rooms.sortOrder }).from(rooms).where(eq(rooms.sessionId, input.sessionId));
    if (existing.some((r) => r.roomNumber.toLowerCase() === input.roomNumber.toLowerCase())) {
      throw new AppError("CONFLICT", `Room ${input.roomNumber} already exists in this session.`);
    }
    const [created] = await tx
      .insert(rooms)
      .values({
        sessionId: input.sessionId,
        roomNumber: input.roomNumber,
        nominalCapacity: input.nominalCapacity,
        overflowTolerance: input.overflowTolerance,
        sortOrder: Math.max(0, ...existing.map((r) => r.sortOrder)) + 1,
      })
      .returning({ id: rooms.id });
    await writeAudit(tx, actor, {
      action: "room_create",
      sessionId: input.sessionId,
      after: { room: input.roomNumber, nominalCapacity: input.nominalCapacity, overflowTolerance: input.overflowTolerance },
    });
    return { roomId: created.id };
  });
}

export async function deleteRoom(db: Db, actor: Actor | null, raw: unknown) {
  assertPermission(actor, "rooms:configure");
  const { roomId } = parseInput(z.object({ roomId: z.uuid() }), raw);
  return db.transaction(async (tx) => {
    const room = (await lockRooms(tx, [roomId])).get(roomId);
    if (!room) throw new AppError("NOT_FOUND", "Room not found.");
    const [assigned] = await tx.select({ id: teamRoomAssignments.id }).from(teamRoomAssignments).where(eq(teamRoomAssignments.roomId, roomId)).limit(1);
    if (assigned || room.occupancy > 0) throw new AppError("CONFLICT", `Room ${room.roomNumber} has teams allocated. Move them first.`);
    await tx.delete(rooms).where(eq(rooms.id, roomId));
    await writeAudit(tx, actor, {
      action: "room_update",
      sessionId: room.sessionId,
      before: { room: room.roomNumber, nominalCapacity: room.nominalCapacity, overflowTolerance: room.overflowTolerance },
      after: { room: room.roomNumber, deleted: true },
    });
    return { roomId };
  });
}

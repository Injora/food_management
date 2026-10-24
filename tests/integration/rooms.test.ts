import { eq, sql } from "drizzle-orm";
import { expect, it } from "vitest";

import { auditLogs, roomAllocations, rooms, teamRoomAssignments } from "@/db/schema";
import type { SessionId } from "@/lib/domain";
import type { Actor } from "@/server/auth/permissions";
import { loadBoard } from "@/server/services/board";
import { checkIn } from "@/server/services/checkin";
import { allocateTeam, createRoom, moveTeam, releaseAllocation, updateRoom, updateSession, type CapacityErrorDetails } from "@/server/services/rooms";
import { withdrawParticipant } from "@/server/services/teams";
import { describeDb, expectAppError, makeActor, makeTeam, room, setRoom, teamState, useTestDb } from "../helpers";

describeDb("Room allocation (PostgreSQL)", () => {
  const t = useTestDb();
  const occupancy = async (id: string) => (await t.db.select({ o: rooms.occupancy }).from(rooms).where(eq(rooms.id, id)))[0].o;
  const seatedCount = async (id: string) => (await t.db.select().from(roomAllocations).where(eq(roomAllocations.roomId, id))).length;

  /** Fills a room to `n` people with throwaway teams of up to 4. */
  async function fill(admin: Actor, session: SessionId, roomId: string, n: number, prefix: string) {
    for (let i = 0; n > 0; i++) {
      const size = Math.min(4, n);
      const team = await makeTeam(t.db, admin, `${prefix} ${i}`, size);
      await allocateTeam(t.db, admin, { sessionId: session, teamId: team.teamId, roomId, participantIds: team.memberIds });
      n -= size;
    }
  }

  it("allocates a team that fits and counts participants, not teams", async () => {
    const admin = await makeActor(t.db);
    const volunteer = await makeActor(t.db, "organizer");
    const r401 = await room(t.db, "hackathon", "401");
    const { teamId, memberIds } = await makeTeam(t.db, admin, "Fits", 4);

    const res = await allocateTeam(t.db, volunteer, { sessionId: "hackathon", teamId, roomId: r401.id, participantIds: memberIds });
    expect(res).toMatchObject({ roomNumber: "401", added: 4, occupancy: 4, nominalCapacity: 60, overNominal: false });
    expect(await occupancy(r401.id)).toBe(4);
    expect((await teamState(t.db, admin, teamId)).rooms.hackathon).toMatchObject({ roomNumber: "401", allocated: 4 });
    const [log] = await t.db.select().from(auditLogs).where(eq(auditLogs.action, "room_assign"));
    expect(log).toMatchObject({ actorId: volunteer.id, sessionId: "hackathon", after: { room: "401", occupancy: 4 } });
  });

  it("allows overflow within the tolerance and rejects beyond it with alternatives", async () => {
    const admin = await makeActor(t.db);
    const [r401, r402] = await Promise.all([room(t.db, "hackathon", "401"), room(t.db, "hackathon", "402")]);
    await fill(admin, "hackathon", r401.id, 59, "Fill401");
    await fill(admin, "hackathon", r402.id, 58, "Fill402");

    // 59/60 + 4 = 63: allowed (within +3).
    const four = await makeTeam(t.db, admin, "Four", 4);
    const ok = await allocateTeam(t.db, admin, { sessionId: "hackathon", teamId: four.teamId, roomId: r401.id, participantIds: four.memberIds });
    expect(ok).toMatchObject({ occupancy: 63, overNominal: true });

    // 63/60 + 1 = 64: rejected.
    const one = await makeTeam(t.db, admin, "One", 1);
    const err = await expectAppError(
      allocateTeam(t.db, admin, { sessionId: "hackathon", teamId: one.teamId, roomId: r401.id, participantIds: one.memberIds }),
      "CAPACITY_EXCEEDED",
    );
    expect(err.message).toBe(
      "Maximum capacity reached for Room 401. Room capacity limit reached, including the 3-person tolerance. Please allocate this team to another room.",
    );
    const details = err.details as CapacityErrorDetails;
    expect(details).toMatchObject({ roomNumber: "401", occupancy: 63, nominalCapacity: 60, effectiveMax: 63, requested: 1, projected: 64 });
    // Every other room fits 1 within nominal; emptiest first, 402 (58/60) last.
    const alternatives = details.alternatives.map((a) => a.roomNumber);
    expect(alternatives.slice(0, 2).sort()).toEqual(["501", "502"]);
    expect(alternatives.at(-1)).toBe("402");
    expect(alternatives).toHaveLength(8);
    expect(details.alternatives.every((a) => a.decision === "fits")).toBe(true);
    expect(await occupancy(r401.id)).toBe(63);
    expect((await teamState(t.db, admin, one.teamId)).rooms.hackathon).toBeNull();
    expect(await t.db.select().from(teamRoomAssignments).where(eq(teamRoomAssignments.teamId, one.teamId))).toHaveLength(0);
  });

  it("rejects a team that exceeds remaining capacity and reports when no room fits", async () => {
    const admin = await makeActor(t.db);
    const hackRooms = await Promise.all(["401", "402", "501", "502", "403", "405", "503", "504", "505"].map((n) => room(t.db, "hackathon", n)));
    for (const r of hackRooms) await setRoom(t.db, r.id, 4, 0);
    for (const [i, r] of hackRooms.entries()) await fill(admin, "hackathon", r.id, 4, `Full${i}`);

    const big = await makeTeam(t.db, admin, "Big", 4);
    const err = await expectAppError(
      allocateTeam(t.db, admin, { sessionId: "hackathon", teamId: big.teamId, roomId: hackRooms[0].id, participantIds: big.memberIds }),
      "CAPACITY_EXCEEDED",
    );
    expect((err.details as CapacityErrorDetails).alternatives).toEqual([]);
    for (const r of hackRooms) expect(await occupancy(r.id)).toBe(4);
  });

  it("matches the tolerance decision table on a 40-person room", async () => {
    const admin = await makeActor(t.db);
    const r403 = await room(t.db, "hackathon", "403");
    await fill(admin, "hackathon", r403.id, 40, "Forty");
    const four = await makeTeam(t.db, admin, "Four More", 4);
    // 40/40 + 4 = 44 > 43: rejected.
    await expectAppError(
      allocateTeam(t.db, admin, { sessionId: "hackathon", teamId: four.teamId, roomId: r403.id, participantIds: four.memberIds }),
      "CAPACITY_EXCEEDED",
    );
    // 40/40 + 3 = 43: allowed.
    const three = await makeTeam(t.db, admin, "Three More", 3);
    const ok = await allocateTeam(t.db, admin, { sessionId: "hackathon", teamId: three.teamId, roomId: r403.id, participantIds: three.memberIds });
    expect(ok).toMatchObject({ occupancy: 43, nominalCapacity: 40, overNominal: true });
  });

  it("allocates only the members who are present, and adds late arrivals to the same room", async () => {
    const admin = await makeActor(t.db);
    const r502 = await room(t.db, "hackathon", "502");
    const { teamId, memberIds } = await makeTeam(t.db, admin, "Stragglers", 4);
    await checkIn(t.db, admin, { teamId, participantIds: memberIds.slice(0, 2) });
    const present = (await teamState(t.db, admin, teamId)).members.filter((m) => m.checkIn).map((m) => m.id);

    await allocateTeam(t.db, admin, { sessionId: "hackathon", teamId, roomId: r502.id, participantIds: present });
    expect(await occupancy(r502.id)).toBe(2);
    let team = await teamState(t.db, admin, teamId);
    expect(team.rooms.hackathon).toMatchObject({ roomNumber: "502", allocated: 2 });
    expect(team.members.map((m) => m.rooms.hackathon === r502.id)).toEqual([true, true, false, false]);

    // Re-sending the same members is a no-op; a third member joins later.
    expect((await allocateTeam(t.db, admin, { sessionId: "hackathon", teamId, roomId: r502.id, participantIds: present })).added).toBe(0);
    await allocateTeam(t.db, admin, { sessionId: "hackathon", teamId, roomId: r502.id, participantIds: [memberIds[2]] });
    expect(await occupancy(r502.id)).toBe(3);

    // The team can't be split across rooms without an explicit move.
    const r401 = await room(t.db, "hackathon", "401");
    await expectAppError(
      allocateTeam(t.db, admin, { sessionId: "hackathon", teamId, roomId: r401.id, participantIds: [memberIds[3]] }),
      "ALREADY_ASSIGNED",
    );

    // Releasing one member frees exactly one seat.
    await releaseAllocation(t.db, admin, { sessionId: "hackathon", teamId, participantIds: [memberIds[0]] });
    expect(await occupancy(r502.id)).toBe(2);
    team = await teamState(t.db, admin, teamId);
    expect(team.rooms.hackathon?.allocated).toBe(2);
  });

  it("updates both rooms' occupancy on reassignment and refuses a move into a full room", async () => {
    const admin = await makeActor(t.db);
    const volunteer = await makeActor(t.db, "organizer");
    const [r401, r402] = await Promise.all([room(t.db, "hackathon", "401"), room(t.db, "hackathon", "402")]);
    const { teamId, memberIds } = await makeTeam(t.db, admin, "Mover", 4);
    await allocateTeam(t.db, admin, { sessionId: "hackathon", teamId, roomId: r401.id, participantIds: memberIds });

    const moved = await moveTeam(t.db, volunteer, { sessionId: "hackathon", teamId, toRoomId: r402.id });
    expect(moved).toMatchObject({ roomNumber: "402", occupancy: 4 });
    expect(await occupancy(r401.id)).toBe(0);
    expect(await occupancy(r402.id)).toBe(4);
    expect(await seatedCount(r402.id)).toBe(4);
    const [log] = await t.db.select().from(auditLogs).where(eq(auditLogs.action, "room_move"));
    expect(log).toMatchObject({ before: { room: "401", teamAllocated: 4 }, after: { room: "402", teamAllocated: 4 } });

    // 401 now nearly full: moving back must fit 401's own limit.
    await fill(admin, "hackathon", r401.id, 61, "Block");
    const err = await expectAppError(moveTeam(t.db, admin, { sessionId: "hackathon", teamId, toRoomId: r401.id }), "CAPACITY_EXCEEDED");
    expect((err.details as CapacityErrorDetails).projected).toBe(65);
    // A rejected move leaves everything where it was.
    expect(await occupancy(r402.id)).toBe(4);
    expect(await occupancy(r401.id)).toBe(61);
    expect((await teamState(t.db, admin, teamId)).rooms.hackathon?.roomNumber).toBe("402");
  });

  it("never lets concurrent allocations exceed a room's limit", async () => {
    const admin = await makeActor(t.db);
    const r505 = await room(t.db, "hackathon", "505");
    await setRoom(t.db, r505.id, 20, 3); // limit 23
    const teams = [];
    for (let i = 0; i < 12; i++) teams.push(await makeTeam(t.db, admin, `Racer ${i}`, 4));
    const volunteers = await Promise.all(teams.map(() => makeActor(t.db, "organizer")));

    const results = await Promise.allSettled(
      teams.map((team, i) => allocateTeam(t.db, volunteers[i], { sessionId: "hackathon", teamId: team.teamId, roomId: r505.id, participantIds: team.memberIds })),
    );
    const ok = results.filter((r) => r.status === "fulfilled").length;
    const rejected = results.filter((r) => r.status === "rejected");
    // 5 teams of 4 = 20 seats; a sixth would make 24 > 23.
    expect(ok).toBe(5);
    expect(rejected.every((r) => (r as PromiseRejectedResult).reason.code === "CAPACITY_EXCEEDED")).toBe(true);
    expect(await occupancy(r505.id)).toBe(20);
    expect(await seatedCount(r505.id)).toBe(20);
  });

  it("enforces the limit in the database even if the service is bypassed", async () => {
    const admin = await makeActor(t.db);
    const r504 = await room(t.db, "hackathon", "504");
    await setRoom(t.db, r504.id, 2, 0);
    const { teamId, memberIds } = await makeTeam(t.db, admin, "Bypass", 3);
    await t.db.insert(teamRoomAssignments).values({ sessionId: "hackathon", teamId, roomId: r504.id });
    await t.db.insert(roomAllocations).values(memberIds.slice(0, 2).map((p) => ({ sessionId: "hackathon" as const, roomId: r504.id, teamId, participantId: p })));
    await expect(
      t.db.insert(roomAllocations).values({ sessionId: "hackathon", roomId: r504.id, teamId, participantId: memberIds[2] }),
    ).rejects.toThrow();
    expect(await occupancy(r504.id)).toBe(2);
    // The same participant can't hold two seats in one session.
    await expect(
      t.db.insert(roomAllocations).values({ sessionId: "hackathon", roomId: r504.id, teamId, participantId: memberIds[0] }),
    ).rejects.toThrow();
  });

  it("keeps open-source talk and hackathon allocations independent", async () => {
    const admin = await makeActor(t.db);
    const talk401 = await room(t.db, "talks", "401");
    const hack401 = await room(t.db, "hackathon", "401");
    const hack403 = await room(t.db, "hackathon", "403");
    const { teamId, memberIds } = await makeTeam(t.db, admin, "Both", 4);

    await allocateTeam(t.db, admin, { sessionId: "talks", teamId, roomId: talk401.id, participantIds: memberIds });
    await allocateTeam(t.db, admin, { sessionId: "hackathon", teamId, roomId: hack401.id, participantIds: memberIds });
    expect(await occupancy(talk401.id)).toBe(4);
    expect(await occupancy(hack401.id)).toBe(4);

    await moveTeam(t.db, admin, { sessionId: "hackathon", teamId, toRoomId: hack403.id });
    await releaseAllocation(t.db, admin, { sessionId: "talks", teamId });
    const team = await teamState(t.db, admin, teamId);
    expect(team.rooms.talks).toBeNull();
    expect(team.rooms.hackathon).toMatchObject({ roomNumber: "403", allocated: 4 });
    expect(await occupancy(talk401.id)).toBe(0);
    expect(await occupancy(hack401.id)).toBe(0);
    expect(await occupancy(hack403.id)).toBe(4);

    // A hackathon room can't be used for a talks allocation.
    await expectAppError(allocateTeam(t.db, admin, { sessionId: "talks", teamId, roomId: hack403.id, participantIds: memberIds }), "VALIDATION");
  });

  it("releases a withdrawn member's seats", async () => {
    const admin = await makeActor(t.db);
    const r402 = await room(t.db, "talks", "402");
    const { teamId, memberIds } = await makeTeam(t.db, admin, "Leaver", 3);
    await allocateTeam(t.db, admin, { sessionId: "talks", teamId, roomId: r402.id, participantIds: memberIds });
    await withdrawParticipant(t.db, admin, { participantId: memberIds[1], reason: "Left the event" });
    expect(await occupancy(r402.id)).toBe(2);
  });

  it("refuses capacity changes that would hide an overflow; admin only", async () => {
    const admin = await makeActor(t.db);
    const volunteer = await makeActor(t.db, "organizer");
    const r501 = await room(t.db, "hackathon", "501");
    await fill(admin, "hackathon", r501.id, 50, "Cap");
    await expectAppError(updateRoom(t.db, volunteer, { roomId: r501.id, nominalCapacity: 70, overflowTolerance: 3 }), "FORBIDDEN");
    await expectAppError(updateRoom(t.db, admin, { roomId: r501.id, nominalCapacity: 45, overflowTolerance: 3 }), "CONFLICT");
    await updateRoom(t.db, admin, { roomId: r501.id, nominalCapacity: 48, overflowTolerance: 2 });
    expect(await occupancy(r501.id)).toBe(50);
    const after = await room(t.db, "hackathon", "501");
    expect(after).toMatchObject({ nominalCapacity: 48, overflowTolerance: 2 });

    // Session-wide tolerance change applies per room and is refused if a room would exceed it.
    const [session] = await t.db.execute<{ starts_at: string; ends_at: string }>(sql`select starts_at, ends_at from event_sessions where id = 'hackathon'`).then((r) => r.rows);
    const times = { startsAt: new Date(session.starts_at).toISOString(), endsAt: new Date(session.ends_at).toISOString() };
    await expectAppError(updateSession(t.db, admin, { sessionId: "hackathon", name: "Hackathon", ...times, overflowTolerance: 1 }), "CONFLICT");
    await updateSession(t.db, admin, { sessionId: "hackathon", name: "Hackathon", ...times, overflowTolerance: 5 });
    const board = await loadBoard(t.db, admin);
    expect(board.rooms.filter((r) => r.sessionId === "hackathon").every((r) => r.overflowTolerance === 5)).toBe(true);
    expect(board.rooms.filter((r) => r.sessionId === "talks").every((r) => r.nominalCapacity === null)).toBe(true);
  });
});

describeDb("Open-source talk rooms have no capacity limit (PostgreSQL)", () => {
  const t = useTestDb();
  const occupancy = async (id: string) => (await t.db.select({ o: rooms.occupancy }).from(rooms).where(eq(rooms.id, id)))[0].o;
  const seatedCount = async (id: string) => (await t.db.select().from(roomAllocations).where(eq(roomAllocations.roomId, id))).length;
  async function roomState(admin: Actor, roomId: string) {
    const board = await loadBoard(t.db, admin);
    return board.rooms.find((r) => r.id === roomId)!;
  }

  it("accepts allocations far beyond the former 60-person capacity", async () => {
    const admin = await makeActor(t.db);
    const volunteer = await makeActor(t.db, "organizer");
    const r401 = await room(t.db, "talks", "401");
    expect(r401.nominalCapacity).toBeNull();

    // 20 teams of 4 = 80 participants, all into Room 401, concurrently.
    const teams = [];
    for (let i = 0; i < 20; i++) teams.push(await makeTeam(t.db, admin, `Talker ${i}`, 4));
    const results = await Promise.allSettled(
      teams.map((team) => allocateTeam(t.db, volunteer, { sessionId: "talks", teamId: team.teamId, roomId: r401.id, participantIds: team.memberIds })),
    );
    expect(results.every((r) => r.status === "fulfilled")).toBe(true);
    const last = (results.at(-1) as PromiseFulfilledResult<Awaited<ReturnType<typeof allocateTeam>>>).value;
    expect(last).toMatchObject({ nominalCapacity: null, overNominal: false });

    const state = await roomState(admin, r401.id);
    expect(state).toMatchObject({ occupancy: 80, nominalCapacity: null });
    expect(state.teams).toHaveLength(20);
  });

  it("keeps team and participant counts accurate, including partial teams", async () => {
    const admin = await makeActor(t.db);
    const r402 = await room(t.db, "talks", "402");
    const a = await makeTeam(t.db, admin, "Alpha", 4);
    const b = await makeTeam(t.db, admin, "Beta", 3);
    await allocateTeam(t.db, admin, { sessionId: "talks", teamId: a.teamId, roomId: r402.id, participantIds: a.memberIds.slice(0, 2) });
    await allocateTeam(t.db, admin, { sessionId: "talks", teamId: b.teamId, roomId: r402.id, participantIds: b.memberIds });

    let state = await roomState(admin, r402.id);
    expect(state.occupancy).toBe(5);
    expect(state.teams.map((x) => [x.teamName, x.allocated, x.size])).toEqual([
      ["Alpha", 2, 4],
      ["Beta", 3, 3],
    ]);
    expect(await seatedCount(r402.id)).toBe(5);

    // A late member joins; one Beta member leaves the room.
    await allocateTeam(t.db, admin, { sessionId: "talks", teamId: a.teamId, roomId: r402.id, participantIds: [a.memberIds[2]] });
    await releaseAllocation(t.db, admin, { sessionId: "talks", teamId: b.teamId, participantIds: [b.memberIds[0]] });
    state = await roomState(admin, r402.id);
    expect(state.occupancy).toBe(5);
    expect(state.teams.map((x) => x.allocated)).toEqual([3, 2]);

    await releaseAllocation(t.db, admin, { sessionId: "talks", teamId: b.teamId });
    state = await roomState(admin, r402.id);
    expect(state.teams.map((x) => x.teamName)).toEqual(["Alpha"]);
    expect(state.occupancy).toBe(3);
  });

  it("updates both rooms on reassignment", async () => {
    const admin = await makeActor(t.db);
    const [r401, r501] = await Promise.all([room(t.db, "talks", "401"), room(t.db, "talks", "501")]);
    for (let i = 0; i < 16; i++) {
      const filler = await makeTeam(t.db, admin, `Busy ${i}`, 4);
      await allocateTeam(t.db, admin, { sessionId: "talks", teamId: filler.teamId, roomId: r501.id, participantIds: filler.memberIds });
    }
    const team = await makeTeam(t.db, admin, "Mover", 4);
    await allocateTeam(t.db, admin, { sessionId: "talks", teamId: team.teamId, roomId: r401.id, participantIds: team.memberIds });
    // 501 already holds 64 people: a move there is still allowed.
    const moved = await moveTeam(t.db, admin, { sessionId: "talks", teamId: team.teamId, toRoomId: r501.id });
    expect(moved).toMatchObject({ roomNumber: "501", occupancy: 68 });
    expect((await roomState(admin, r401.id)).occupancy).toBe(0);
    const s501 = await roomState(admin, r501.id);
    expect(s501.occupancy).toBe(68);
    expect(s501.teams).toHaveLength(17);
    expect(await occupancy(r401.id)).toBe(0);
  });

  it("still prevents duplicate allocations", async () => {
    const admin = await makeActor(t.db);
    const [r401, r402] = await Promise.all([room(t.db, "talks", "401"), room(t.db, "talks", "402")]);
    const { teamId, memberIds } = await makeTeam(t.db, admin, "Twice", 3);
    await allocateTeam(t.db, admin, { sessionId: "talks", teamId, roomId: r401.id, participantIds: memberIds });
    // Same request again (double click, retry): no new seats.
    const again = await allocateTeam(t.db, admin, { sessionId: "talks", teamId, roomId: r401.id, participantIds: memberIds });
    expect(again.added).toBe(0);
    expect(await occupancy(r401.id)).toBe(3);
    // The team can't be in two talk rooms without an explicit move.
    await expectAppError(allocateTeam(t.db, admin, { sessionId: "talks", teamId, roomId: r402.id, participantIds: memberIds }), "ALREADY_ASSIGNED");
    // And the database refuses a second seat for the same participant in the session.
    await expect(
      t.db.insert(roomAllocations).values({ sessionId: "talks", roomId: r401.id, teamId, participantId: memberIds[0] }),
    ).rejects.toThrow();
    expect(await seatedCount(r402.id)).toBe(0);
  });

  it("keeps hackathon limits enforced while talks are unlimited", async () => {
    const admin = await makeActor(t.db);
    const hack = await room(t.db, "hackathon", "403");
    const talk = await room(t.db, "talks", "401");
    await setRoom(t.db, hack.id, 4, 3); // limit 7
    const team = await makeTeam(t.db, admin, "Eight", 8);
    await allocateTeam(t.db, admin, { sessionId: "talks", teamId: team.teamId, roomId: talk.id, participantIds: team.memberIds });
    await expectAppError(
      allocateTeam(t.db, admin, { sessionId: "hackathon", teamId: team.teamId, roomId: hack.id, participantIds: team.memberIds }),
      "CAPACITY_EXCEEDED",
    );
    const seven = await allocateTeam(t.db, admin, { sessionId: "hackathon", teamId: team.teamId, roomId: hack.id, participantIds: team.memberIds.slice(0, 7) });
    expect(seven).toMatchObject({ occupancy: 7, nominalCapacity: 4, overNominal: true });
  });

  it("keeps the configuration session-specific", async () => {
    const admin = await makeActor(t.db);
    const talk = await room(t.db, "talks", "402");
    const hack = await room(t.db, "hackathon", "402");
    await expectAppError(updateRoom(t.db, admin, { roomId: talk.id, nominalCapacity: 60, overflowTolerance: 3 }), "VALIDATION");
    await expectAppError(updateRoom(t.db, admin, { roomId: hack.id, nominalCapacity: null, overflowTolerance: 3 }), "VALIDATION");
    await expectAppError(createRoom(t.db, admin, { sessionId: "talks", roomNumber: "T9", nominalCapacity: 50, overflowTolerance: 3 }), "VALIDATION");
    await createRoom(t.db, admin, { sessionId: "talks", roomNumber: "T9", nominalCapacity: null, overflowTolerance: 3 });
    // The database itself refuses an unlimited hackathon room.
    await expect(t.db.update(rooms).set({ nominalCapacity: null }).where(eq(rooms.id, hack.id))).rejects.toThrow();
  });
});

import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";

import type { Executor } from "@/db";
import {
  checkIns,
  couponIssuances,
  eventSessions,
  participants,
  roomAllocations,
  rooms,
  teams,
  users,
} from "@/db/schema";
import {
  checkInStatus,
  COUPON_TYPES,
  formatParticipantCode,
  SESSION_IDS,
  type CheckInStatus,
  type CouponType,
  type SessionId,
} from "@/lib/domain";
import { assertPermission, type Actor } from "@/server/auth/permissions";

/**
 * The live operational state every desk screen works from: one query set,
 * assembled in memory. Everything is derived from persisted rows, so counts
 * can't drift from the records behind them.
 */

export type Stamp = { at: string; by: string | null };

export type MemberState = {
  id: string;
  code: string;
  name: string;
  email: string | null;
  phone: string | null;
  isLeader: boolean;
  withdrawn: boolean;
  checkIn: Stamp | null;
  coupons: Record<CouponType, (Stamp & { id: string }) | null>;
  rooms: Record<SessionId, string | null>;
};

export type TeamRoom = { roomId: string; roomNumber: string; allocated: number };

export type TeamState = {
  id: string;
  code: string;
  name: string;
  college: string | null;
  leaderName: string | null;
  declaredMemberCount: number | null;
  /** Active (not withdrawn) registered members. */
  size: number;
  present: number;
  status: CheckInStatus;
  /** Coupons issued to active members, per meal (entitlement = size). */
  coupons: Record<CouponType, number>;
  rooms: Record<SessionId, TeamRoom | null>;
  members: MemberState[];
};

export type RoomState = {
  id: string;
  sessionId: SessionId;
  roomNumber: string;
  /** Null = no capacity limit (open-source talk rooms). */
  nominalCapacity: number | null;
  overflowTolerance: number;
  occupancy: number;
  sortOrder: number;
  teams: { teamId: string; teamName: string; teamCode: string; allocated: number; size: number }[];
};

export type SessionState = { id: SessionId; name: string; startsAt: string; endsAt: string };

export type Board = {
  teams: TeamState[];
  rooms: RoomState[];
  sessions: SessionState[];
  /** Totals that include records outside the active member list (e.g. withdrawn members). */
  couponTotals: Record<CouponType, number>;
  generatedAt: string;
};

const emptyCoupons = <T>(v: T) => Object.fromEntries(COUPON_TYPES.map((c) => [c, v])) as Record<CouponType, T>;
const emptySessions = <T>(v: T) => Object.fromEntries(SESSION_IDS.map((s) => [s, v])) as Record<SessionId, T>;

export async function loadBoard(exec: Executor, actor: Actor | null, opts: { teamIds?: string[] } = {}): Promise<Board> {
  assertPermission(actor, "board:view");
  const teamFilter = opts.teamIds ? inArray(teams.id, opts.teamIds) : undefined;

  const [teamRows, memberRows, checkInRows, couponRows, allocationRows, roomRows, sessionRows, totals] = await Promise.all([
    exec
      .select({
        id: teams.id,
        code: teams.teamCode,
        name: teams.teamName,
        college: teams.college,
        declaredMemberCount: teams.declaredMemberCount,
      })
      .from(teams)
      .where(and(isNull(teams.archivedAt), teamFilter))
      .orderBy(asc(teams.teamName), asc(teams.teamCode)),
    exec
      .select({
        id: participants.id,
        no: participants.participantNo,
        teamId: participants.teamId,
        name: participants.name,
        email: participants.email,
        phone: participants.phone,
        isLeader: participants.isLeader,
        withdrawnAt: participants.withdrawnAt,
      })
      .from(participants)
      .innerJoin(teams, eq(teams.id, participants.teamId))
      .where(and(isNull(teams.archivedAt), teamFilter))
      .orderBy(asc(participants.teamId), sql`${participants.isLeader} desc`, asc(participants.position), asc(participants.participantNo)),
    exec
      .select({ participantId: checkIns.participantId, at: checkIns.checkedInAt, by: users.name })
      .from(checkIns)
      .leftJoin(users, eq(users.id, checkIns.checkedInBy))
      .where(and(isNull(checkIns.undoneAt), opts.teamIds ? inArray(checkIns.teamId, opts.teamIds) : undefined)),
    exec
      .select({
        id: couponIssuances.id,
        participantId: couponIssuances.participantId,
        couponType: couponIssuances.couponType,
        at: couponIssuances.issuedAt,
        by: users.name,
      })
      .from(couponIssuances)
      .leftJoin(users, eq(users.id, couponIssuances.issuedBy))
      .where(and(isNull(couponIssuances.revertedAt), opts.teamIds ? inArray(couponIssuances.teamId, opts.teamIds) : undefined)),
    exec
      .select({
        sessionId: roomAllocations.sessionId,
        roomId: roomAllocations.roomId,
        teamId: roomAllocations.teamId,
        participantId: roomAllocations.participantId,
      })
      .from(roomAllocations),
    exec.select().from(rooms).orderBy(asc(rooms.sessionId), asc(rooms.sortOrder), asc(rooms.roomNumber)),
    exec.select().from(eventSessions).orderBy(asc(eventSessions.startsAt)),
    exec
      .select({ couponType: couponIssuances.couponType, n: sql<number>`count(*)::int` })
      .from(couponIssuances)
      .where(isNull(couponIssuances.revertedAt))
      .groupBy(couponIssuances.couponType),
  ]);

  const checkInBy = new Map(checkInRows.map((c) => [c.participantId, { at: c.at.toISOString(), by: c.by }]));
  const couponsBy = new Map<string, Record<CouponType, (Stamp & { id: string }) | null>>();
  for (const c of couponRows) {
    const entry = couponsBy.get(c.participantId) ?? emptyCoupons(null);
    entry[c.couponType] = { id: c.id, at: c.at.toISOString(), by: c.by };
    couponsBy.set(c.participantId, entry);
  }
  const allocationBy = new Map<string, Record<SessionId, string | null>>();
  for (const a of allocationRows) {
    const entry = allocationBy.get(a.participantId) ?? emptySessions<string | null>(null);
    entry[a.sessionId] = a.roomId;
    allocationBy.set(a.participantId, entry);
  }

  const membersByTeam = new Map<string, MemberState[]>();
  for (const m of memberRows) {
    const list = membersByTeam.get(m.teamId) ?? [];
    list.push({
      id: m.id,
      code: formatParticipantCode(m.no),
      name: m.name,
      email: m.email,
      phone: m.phone,
      isLeader: m.isLeader,
      withdrawn: m.withdrawnAt !== null,
      checkIn: checkInBy.get(m.id) ?? null,
      coupons: couponsBy.get(m.id) ?? emptyCoupons(null),
      rooms: allocationBy.get(m.id) ?? emptySessions<string | null>(null),
    });
    membersByTeam.set(m.teamId, list);
  }

  const roomById = new Map(roomRows.map((r) => [r.id, r]));
  const teamStates: TeamState[] = teamRows.map((t) => {
    const all = membersByTeam.get(t.id) ?? [];
    // Active members first; withdrawn ones stay visible at the end.
    const members = [...all.filter((m) => !m.withdrawn), ...all.filter((m) => m.withdrawn)];
    const active = members.filter((m) => !m.withdrawn);
    const present = active.filter((m) => m.checkIn).length;
    const coupons = emptyCoupons(0);
    for (const m of active) for (const c of COUPON_TYPES) if (m.coupons[c]) coupons[c]++;
    const teamRooms = emptySessions<TeamRoom | null>(null);
    for (const m of members) {
      for (const s of SESSION_IDS) {
        const roomId = m.rooms[s];
        if (!roomId) continue;
        const current = teamRooms[s];
        if (current) current.allocated++;
        else teamRooms[s] = { roomId, roomNumber: roomById.get(roomId)?.roomNumber ?? "?", allocated: 1 };
      }
    }
    return {
      id: t.id,
      code: t.code,
      name: t.name,
      college: t.college,
      leaderName: active.find((m) => m.isLeader)?.name ?? null,
      declaredMemberCount: t.declaredMemberCount,
      size: active.length,
      present,
      status: checkInStatus(present, active.length),
      coupons,
      rooms: teamRooms,
      members,
    };
  });

  const teamById = new Map(teamStates.map((t) => [t.id, t]));
  const roomTeams = new Map<string, Map<string, number>>();
  for (const a of allocationRows) {
    const perTeam = roomTeams.get(a.roomId) ?? new Map<string, number>();
    perTeam.set(a.teamId, (perTeam.get(a.teamId) ?? 0) + 1);
    roomTeams.set(a.roomId, perTeam);
  }
  const roomStates: RoomState[] = roomRows.map((r) => ({
    id: r.id,
    sessionId: r.sessionId,
    roomNumber: r.roomNumber,
    nominalCapacity: r.nominalCapacity,
    overflowTolerance: r.overflowTolerance,
    occupancy: r.occupancy,
    sortOrder: r.sortOrder,
    teams: [...(roomTeams.get(r.id) ?? new Map<string, number>()).entries()]
      .map(([teamId, allocated]) => {
        const team = teamById.get(teamId);
        return { teamId, teamName: team?.name ?? "(archived team)", teamCode: team?.code ?? "", allocated, size: team?.size ?? 0 };
      })
      .sort((a, b) => a.teamName.localeCompare(b.teamName)),
  }));

  const couponTotals = emptyCoupons(0);
  for (const t of totals) couponTotals[t.couponType] = t.n;

  return {
    teams: teamStates,
    rooms: roomStates,
    sessions: sessionRows.map((s) => ({ id: s.id, name: s.name, startsAt: s.startsAt.toISOString(), endsAt: s.endsAt.toISOString() })),
    couponTotals,
    generatedAt: new Date().toISOString(),
  };
}


import { COUPON_TYPES, SESSION_IDS, type CouponType, type SessionId } from "./domain";
import type { Board } from "@/server/services/board";

export type Summary = {
  teams: number;
  participants: number;
  present: number;
  teamsFull: number;
  teamsPartial: number;
  teamsNone: number;
  coupons: Record<CouponType, { issued: number; entitled: number }>;
  /** nominal/max are null when the session's rooms have no capacity limit. */
  rooms: Record<SessionId, { occupancy: number; teams: number; nominal: number | null; max: number | null; rooms: number; fullRooms: number }>;
};

/** Dashboard numbers, derived from the persisted records in a board snapshot. */
export function summarize(board: Board): Summary {
  const s: Summary = {
    teams: board.teams.length,
    participants: 0,
    present: 0,
    teamsFull: 0,
    teamsPartial: 0,
    teamsNone: 0,
    coupons: Object.fromEntries(COUPON_TYPES.map((c) => [c, { issued: board.couponTotals[c], entitled: 0 }])) as Summary["coupons"],
    rooms: Object.fromEntries(SESSION_IDS.map((id) => [id, { occupancy: 0, teams: 0, nominal: 0 as number | null, max: 0 as number | null, rooms: 0, fullRooms: 0 }])) as Summary["rooms"],
  };
  for (const t of board.teams) {
    s.participants += t.size;
    s.present += t.present;
    if (t.status === "full") s.teamsFull++;
    else if (t.status === "partial") s.teamsPartial++;
    else s.teamsNone++;
    for (const c of COUPON_TYPES) s.coupons[c].entitled += t.size;
  }
  for (const r of board.rooms) {
    const agg = s.rooms[r.sessionId];
    agg.occupancy += r.occupancy;
    agg.teams += r.teams.length;
    agg.rooms++;
    if (r.nominalCapacity === null || agg.nominal === null || agg.max === null) {
      agg.nominal = agg.max = null;
    } else {
      agg.nominal += r.nominalCapacity;
      agg.max += r.nominalCapacity + r.overflowTolerance;
      if (r.occupancy >= r.nominalCapacity) agg.fullRooms++;
    }
  }
  return s;
}

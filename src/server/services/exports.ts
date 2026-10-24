import { and, asc, eq, isNull } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { z } from "zod";

import type { Db } from "@/db";
import { couponIssuances, participants, roomAllocations, rooms, teams, users } from "@/db/schema";
import { effectiveMax, hardRemaining, isLimited, nominalRemaining } from "@/lib/capacity";
import { CHECK_IN_LABELS, COUPON_TYPES, formatParticipantCode, SESSION_IDS, SESSION_LABELS } from "@/lib/domain";
import { AppError } from "@/lib/errors";
import { assertPermission, type Actor } from "@/server/auth/permissions";
import { listAudit } from "./audit";
import { loadBoard } from "./board";

export const EXPORT_KINDS = ["registrations", "attendance", "team-checkins", "coupons", "coupon-summary", "allocations", "occupancy", "audit"] as const;
export type ExportKind = (typeof EXPORT_KINDS)[number];

type Cell = string | number | null;
export type ExportResult = { fileName: string; rows: Cell[][] };

const stamp = () => new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");
const yesNo = (b: boolean) => (b ? "yes" : "no");

/** Reads straight from the database at request time, so exports are never stale. */
export async function buildExport(db: Db, actor: Actor | null, kind: string, params: URLSearchParams): Promise<ExportResult> {
  assertPermission(actor, "reports:view");
  const parsed = z.enum(EXPORT_KINDS).safeParse(kind);
  if (!parsed.success) throw new AppError("NOT_FOUND", "Unknown report.");

  switch (parsed.data) {
    case "registrations":
    case "attendance": {
      const filter = params.get("status");
      if (filter && !["present", "absent"].includes(filter)) throw new AppError("VALIDATION", "Status must be present or absent.");
      const board = await loadBoard(db, actor);
      const roomNo = new Map(board.rooms.map((r) => [r.id, r.roomNumber]));
      const header = [
        "team_code", "team_name", "college", "participant_id", "name", "email", "phone", "leader", "withdrawn",
        "present", "checked_in_at", "checked_in_by",
        ...COUPON_TYPES.flatMap((c) => [`${c}_issued_at`, `${c}_issued_by`]),
        ...SESSION_IDS.map((s) => `${s}_room`),
      ];
      const rows: Cell[][] = [];
      for (const t of board.teams) {
        for (const m of t.members) {
          if (parsed.data === "attendance" && m.withdrawn) continue;
          if (filter === "present" && !m.checkIn) continue;
          if (filter === "absent" && m.checkIn) continue;
          rows.push([
            t.code, t.name, t.college, m.code, m.name, m.email, m.phone, yesNo(m.isLeader), yesNo(m.withdrawn),
            yesNo(!!m.checkIn), m.checkIn?.at ?? null, m.checkIn?.by ?? null,
            ...COUPON_TYPES.flatMap((c) => [m.coupons[c]?.at ?? null, m.coupons[c]?.by ?? null]),
            ...SESSION_IDS.map((s) => (m.rooms[s] ? (roomNo.get(m.rooms[s]!) ?? null) : null)),
          ]);
        }
      }
      const name = parsed.data === "registrations" ? "registrations" : `attendance${filter ? `-${filter}` : ""}`;
      return { fileName: `${name}-${stamp()}.csv`, rows: [header, ...rows] };
    }
    case "team-checkins": {
      const filter = params.get("status");
      const board = await loadBoard(db, actor);
      const list = board.teams.filter((t) => !filter || t.status === filter);
      return {
        fileName: `team-checkins${filter ? `-${filter}` : ""}-${stamp()}.csv`,
        rows: [
          ["team_code", "team_name", "leader", "team_size", "present", "absent", "status", "absent_members"],
          ...list.map((t) => [
            t.code, t.name, t.leaderName, t.size, t.present, t.size - t.present, CHECK_IN_LABELS[t.status],
            t.members.filter((m) => !m.withdrawn && !m.checkIn).map((m) => m.name).join("; "),
          ]),
        ],
      };
    }
    case "coupon-summary": {
      const board = await loadBoard(db, actor);
      return {
        fileName: `coupon-summary-${stamp()}.csv`,
        rows: [
          ["team_code", "team_name", "team_size", ...COUPON_TYPES.flatMap((c) => [`${c}_issued`, `${c}_pending`])],
          ...board.teams.map((t) => [t.code, t.name, t.size, ...COUPON_TYPES.flatMap((c) => [t.coupons[c], t.size - t.coupons[c]])]),
        ],
      };
    }
    case "coupons": {
      const meal = params.get("meal");
      if (meal && !(COUPON_TYPES as readonly string[]).includes(meal)) throw new AppError("VALIDATION", "Choose lunch, snacks or dinner.");
      const issuer = alias(users, "issuer");
      const reverter = alias(users, "reverter");
      const rows = await db
        .select({
          id: couponIssuances.id,
          couponType: couponIssuances.couponType,
          teamCode: teams.teamCode,
          teamName: teams.teamName,
          no: participants.participantNo,
          name: participants.name,
          issuedAt: couponIssuances.issuedAt,
          issuedBy: issuer.name,
          revertedAt: couponIssuances.revertedAt,
          revertedBy: reverter.name,
          revertReason: couponIssuances.revertReason,
        })
        .from(couponIssuances)
        .innerJoin(participants, eq(participants.id, couponIssuances.participantId))
        .innerJoin(teams, eq(teams.id, couponIssuances.teamId))
        .leftJoin(issuer, eq(issuer.id, couponIssuances.issuedBy))
        .leftJoin(reverter, eq(reverter.id, couponIssuances.revertedBy))
        .where(meal ? eq(couponIssuances.couponType, meal as (typeof COUPON_TYPES)[number]) : undefined)
        .orderBy(asc(couponIssuances.issuedAt));
      return {
        fileName: `coupons${meal ? `-${meal}` : ""}-${stamp()}.csv`,
        rows: [
          ["transaction_id", "meal", "team_code", "team_name", "participant_id", "participant", "issued_at", "issued_by", "status", "reverted_at", "reverted_by", "revert_reason"],
          ...rows.map((r) => [
            r.id, r.couponType, r.teamCode, r.teamName, formatParticipantCode(r.no), r.name, r.issuedAt.toISOString(), r.issuedBy,
            r.revertedAt ? "reverted" : "issued", r.revertedAt?.toISOString() ?? null, r.revertedBy, r.revertReason,
          ]),
        ],
      };
    }
    case "allocations": {
      const session = z.enum(SESSION_IDS).safeParse(params.get("session"));
      if (!session.success) throw new AppError("VALIDATION", "Choose the talks or hackathon session.");
      const rows = await db
        .select({
          roomNumber: rooms.roomNumber,
          teamCode: teams.teamCode,
          teamName: teams.teamName,
          no: participants.participantNo,
          name: participants.name,
          allocatedAt: roomAllocations.allocatedAt,
          allocatedBy: users.name,
        })
        .from(roomAllocations)
        .innerJoin(rooms, eq(rooms.id, roomAllocations.roomId))
        .innerJoin(teams, eq(teams.id, roomAllocations.teamId))
        .innerJoin(participants, eq(participants.id, roomAllocations.participantId))
        .leftJoin(users, eq(users.id, roomAllocations.allocatedBy))
        .where(and(eq(roomAllocations.sessionId, session.data), isNull(teams.archivedAt)))
        .orderBy(asc(rooms.sortOrder), asc(teams.teamName), asc(participants.participantNo));
      return {
        fileName: `${session.data}-room-assignments-${stamp()}.csv`,
        rows: [
          ["session", "room", "team_code", "team_name", "participant_id", "participant", "allocated_at", "allocated_by"],
          ...rows.map((r) => [SESSION_LABELS[session.data], r.roomNumber, r.teamCode, r.teamName, formatParticipantCode(r.no), r.name, r.allocatedAt.toISOString(), r.allocatedBy]),
        ],
      };
    }
    case "occupancy": {
      const board = await loadBoard(db, actor);
      return {
        fileName: `room-occupancy-${stamp()}.csv`,
        rows: [
          ["session", "room", "participants", "teams_count", "nominal_capacity", "overflow_tolerance", "maximum_permitted", "remaining_nominal", "remaining_including_tolerance", "percent_of_nominal", "over_nominal", "teams"],
          // Unlimited (talk) rooms leave the capacity columns blank rather than inventing a limit.
          ...board.rooms.map((r) => [
            SESSION_LABELS[r.sessionId], r.roomNumber, r.occupancy, r.teams.length,
            ...(isLimited(r)
              ? [r.nominalCapacity, r.overflowTolerance, effectiveMax(r), nominalRemaining(r), hardRemaining(r), Math.round((r.occupancy / r.nominalCapacity) * 100), yesNo(r.occupancy > r.nominalCapacity)]
              : ["unlimited", null, null, null, null, null, "no"]),
            r.teams.map((t) => `${t.teamName} (${t.allocated})`).join("; "),
          ]),
        ],
      };
    }
    case "audit": {
      const { rows } = await listAudit(db, actor, { limit: 100_000 });
      const json = (v: unknown) => (v == null ? null : JSON.stringify(v));
      return {
        fileName: `audit-log-${stamp()}.csv`,
        rows: [
          ["timestamp", "actor", "action", "team", "meal", "session", "reason", "before", "after", "details"],
          ...rows.map((r) => [r.createdAt, r.actorEmail, r.action, r.teamLabel, r.couponType, r.sessionId, r.reason, json(r.before), json(r.after), json(r.details)]),
        ],
      };
    }
  }
}

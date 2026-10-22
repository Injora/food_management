import { z } from "zod";

import type { Db } from "@/db";
import { AppError } from "@/lib/errors";
import { MEAL_TYPES, type MealType } from "@/lib/meals";
import { assertPermission, type Actor } from "@/server/auth/permissions";
import { listAudit } from "./audit";
import { listMealDistribution } from "./distribution";
import { listTeams } from "./teams";

export const EXPORT_KINDS = ["teams", "meal", "pending", "audit"] as const;
export type ExportKind = (typeof EXPORT_KINDS)[number];

type Cell = string | number | null;
export type ExportResult = { fileName: string; rows: Cell[][] };

const stamp = () => new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");

/** Reads straight from the database at request time, so exports are never stale. */
export async function buildExport(
  db: Db,
  actor: Actor | null,
  kind: string,
  mealParam: string | null,
): Promise<ExportResult> {
  assertPermission(actor, "reports:view");
  const parsedKind = z.enum(EXPORT_KINDS).safeParse(kind);
  if (!parsedKind.success) throw new AppError("NOT_FOUND", "Unknown export.");

  const needsMeal = parsedKind.data === "meal" || parsedKind.data === "pending";
  let meal: MealType | null = null;
  if (needsMeal) {
    const parsedMeal = z.enum(MEAL_TYPES).safeParse(mealParam);
    if (!parsedMeal.success) throw new AppError("VALIDATION", "Choose breakfast, lunch or dinner.");
    meal = parsedMeal.data;
  }

  switch (parsedKind.data) {
    case "teams": {
      const teams = await listTeams(db, actor);
      return {
        fileName: `teams-${stamp()}.csv`,
        rows: [
          ["team_code", "team_name", "team_leader_name", "team_leader_email", "member_count", ...MEAL_TYPES.flatMap((m) => [`${m}_status`, `${m}_coupons`, `${m}_issued_at`])],
          ...teams.map((t) => [
            t.teamCode,
            t.teamName,
            t.leaderName,
            t.leaderEmail,
            t.memberCount,
            ...MEAL_TYPES.flatMap((m) => [t.meals[m].status, t.meals[m].couponQuantity, t.meals[m].issuedAt]),
          ]),
        ],
      };
    }
    case "meal":
    case "pending": {
      const all = await listMealDistribution(db, actor, meal);
      const rows = parsedKind.data === "pending" ? all.filter((r) => r.status === "pending") : all;
      return {
        fileName: `${meal}-${parsedKind.data === "pending" ? "pending" : "issuance"}-${stamp()}.csv`,
        rows: [
          ["team_code", "team_name", "team_leader_name", "team_leader_email", "member_count", "coupon_quantity", "status", "issued_at", "issued_by"],
          ...rows.map((r) => [r.teamCode, r.teamName, r.leaderName, r.leaderEmail, r.memberCount, r.couponQuantity, r.status, r.issuedAt, r.issuedByName]),
        ],
      };
    }
    case "audit": {
      const { rows } = await listAudit(db, actor, { limit: 100_000 });
      const json = (v: unknown) => (v == null ? null : JSON.stringify(v));
      return {
        fileName: `audit-log-${stamp()}.csv`,
        rows: [
          ["timestamp", "actor", "action", "team", "meal", "reason", "before", "after", "details"],
          ...rows.map((r) => [r.createdAt, r.actorEmail, r.action, r.teamLabel, r.mealType, r.reason, json(r.before), json(r.after), json(r.details)]),
        ],
      };
    }
  }
}

import { desc, eq, sql } from "drizzle-orm";

import type { Db } from "@/db";
import { distributions, teams, users } from "@/db/schema";
import { eventTimeZone } from "@/lib/format";
import { MEAL_TYPES, type MealType } from "@/lib/meals";
import { assertPermission, type Actor } from "@/server/auth/permissions";

export type MealStats = {
  meal: MealType;
  eligibleTeams: number;
  issuedTeams: number;
  pendingTeams: number;
  couponsExpected: number;
  couponsIssued: number;
  /** Computed from quantities, not team counts. */
  couponsRemaining: number;
  lastIssuedAt: string | null;
};

export type DashboardStats = {
  totalTeams: number;
  totalParticipants: number;
  couponsIssuedToday: number;
  couponsIssuedTotal: number;
  couponsExpectedTotal: number;
  /** Issued team-meals / all team-meals, 0..1. */
  overallProgress: number;
  meals: MealStats[];
  recent: {
    teamId: string;
    teamName: string;
    teamCode: string;
    meal: MealType;
    couponQuantity: number;
    issuedAt: string;
    issuedByName: string | null;
  }[];
};

export async function getDashboardStats(db: Db, actor: Actor | null): Promise<DashboardStats> {
  assertPermission(actor, "distribution:view");
  const tz = eventTimeZone();
  const startOfToday = sql`(date_trunc('day', now() at time zone ${tz}) at time zone ${tz})`;

  const [[teamTotals], mealRows, [today], recent] = await Promise.all([
    db
      .select({
        totalTeams: sql<number>`count(*)::int`,
        totalParticipants: sql<number>`coalesce(sum(${teams.memberCount}), 0)::int`,
      })
      .from(teams),
    db
      .select({
        meal: distributions.mealType,
        eligibleTeams: sql<number>`count(*)::int`,
        issuedTeams: sql<number>`count(*) filter (where ${distributions.status} = 'issued')::int`,
        couponsExpected: sql<number>`coalesce(sum(${distributions.couponQuantity}), 0)::int`,
        couponsIssued: sql<number>`coalesce(sum(${distributions.couponQuantity}) filter (where ${distributions.status} = 'issued'), 0)::int`,
        lastIssuedAt: sql<Date | null>`max(${distributions.issuedAt})`,
      })
      .from(distributions)
      .groupBy(distributions.mealType),
    db
      .select({ coupons: sql<number>`coalesce(sum(${distributions.couponQuantity}), 0)::int` })
      .from(distributions)
      .where(sql`${distributions.status} = 'issued' and ${distributions.issuedAt} >= ${startOfToday}`),
    db
      .select({
        teamId: teams.id,
        teamName: teams.teamName,
        teamCode: teams.teamCode,
        meal: distributions.mealType,
        couponQuantity: distributions.couponQuantity,
        issuedAt: distributions.issuedAt,
        issuedByName: users.name,
      })
      .from(distributions)
      .innerJoin(teams, eq(teams.id, distributions.teamId))
      .leftJoin(users, eq(users.id, distributions.issuedBy))
      .where(eq(distributions.status, "issued"))
      .orderBy(desc(distributions.issuedAt))
      .limit(8),
  ]);

  const meals: MealStats[] = MEAL_TYPES.map((meal) => {
    const r = mealRows.find((m) => m.meal === meal);
    const eligibleTeams = r?.eligibleTeams ?? 0;
    const issuedTeams = r?.issuedTeams ?? 0;
    const couponsExpected = r?.couponsExpected ?? 0;
    const couponsIssued = r?.couponsIssued ?? 0;
    const last = r?.lastIssuedAt;
    return {
      meal,
      eligibleTeams,
      issuedTeams,
      pendingTeams: eligibleTeams - issuedTeams,
      couponsExpected,
      couponsIssued,
      couponsRemaining: couponsExpected - couponsIssued,
      lastIssuedAt: last ? new Date(last).toISOString() : null,
    };
  });

  const teamMeals = meals.reduce((s, m) => s + m.eligibleTeams, 0);
  const issuedTeamMeals = meals.reduce((s, m) => s + m.issuedTeams, 0);
  return {
    totalTeams: teamTotals.totalTeams,
    totalParticipants: teamTotals.totalParticipants,
    couponsIssuedToday: today.coupons,
    couponsIssuedTotal: meals.reduce((s, m) => s + m.couponsIssued, 0),
    couponsExpectedTotal: meals.reduce((s, m) => s + m.couponsExpected, 0),
    overallProgress: teamMeals === 0 ? 0 : issuedTeamMeals / teamMeals,
    meals,
    recent: recent.map((r) => ({ ...r, issuedAt: r.issuedAt!.toISOString() })),
  };
}

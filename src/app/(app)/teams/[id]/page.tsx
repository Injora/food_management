import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";

import { AuditList } from "@/components/audit-list";
import { MEAL_ICONS } from "@/components/meal-icon";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { getDb } from "@/db";
import { AppError } from "@/lib/errors";
import { formatDateTime } from "@/lib/format";
import { isMealType, MEAL_LABELS, MEAL_TYPES } from "@/lib/meals";
import { requireActor } from "@/server/auth/current";
import { can } from "@/server/auth/permissions";
import { getTeamDetail } from "@/server/services/teams";
import {
  AdjustQuantityButton,
  CorrectMemberCountButton,
  DeleteTeamButton,
  EditTeamButton,
  RevertIssuanceButton,
} from "../team-forms";

export const metadata: Metadata = { title: "Team" };

export default async function TeamPage({ params, searchParams }: PageProps<"/teams/[id]">) {
  const [{ id }, { from }] = await Promise.all([params, searchParams]);
  const actor = await requireActor();
  let detail;
  try {
    detail = await getTeamDetail(getDb(), actor, id);
  } catch (err) {
    if (err instanceof AppError && err.code === "NOT_FOUND") notFound();
    throw err;
  }
  const { team, history } = detail;
  const isAdmin = can(actor, "teams:edit");
  const issuedMeals = MEAL_TYPES.filter((m) => team.meals[m].status === "issued");
  const back = typeof from === "string" && isMealType(from) ? { href: `/meals/${from}`, label: MEAL_LABELS[from] } : { href: "/teams", label: "Teams" };

  return (
    <div className="flex flex-col gap-6">
      <div>
        <Button variant="ghost" size="sm" className="-ml-2" nativeButton={false} render={<Link href={back.href} />}>
          <ArrowLeft /> {back.label}
        </Button>
        <div className="mt-2 flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <h1 className="text-2xl font-semibold tracking-tight break-words">{team.teamName}</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              <span className="font-mono">{team.teamCode}</span>
              {team.leaderName && ` · Leader: ${team.leaderName}`}
              {team.leaderEmail && ` · ${team.leaderEmail}`}
            </p>
          </div>
          <div className="shrink-0 rounded-xl border bg-card px-4 py-2 text-right">
            <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">Registered members</p>
            <p className="tabular text-3xl font-semibold">{team.memberCount}</p>
          </div>
        </div>
        {isAdmin && (
          <div className="mt-4 flex flex-wrap gap-2">
            <EditTeamButton
              teamId={team.id}
              hasIssued={issuedMeals.length > 0}
              initial={{
                teamName: team.teamName,
                teamCode: team.teamCode,
                leaderName: team.leaderName ?? "",
                leaderEmail: team.leaderEmail ?? "",
                memberCount: team.memberCount,
              }}
            />
            <CorrectMemberCountButton teamId={team.id} memberCount={team.memberCount} />
            {issuedMeals.length === 0 && <DeleteTeamButton teamId={team.id} teamName={team.teamName} />}
          </div>
        )}
      </div>

      <section aria-label="Meals" className="grid gap-3 md:grid-cols-3">
        {MEAL_TYPES.map((m) => {
          const state = team.meals[m];
          const Icon = MEAL_ICONS[m];
          const issued = state.status === "issued";
          return (
            <article key={m} className={`rounded-xl border bg-card p-4 ${issued ? "border-success/40" : ""}`}>
              <div className="flex items-center justify-between gap-2">
                <h2 className="flex items-center gap-2 font-semibold">
                  <Icon className="size-4.5 text-muted-foreground" aria-hidden /> {MEAL_LABELS[m]}
                </h2>
                <StatusBadge status={state.status} />
              </div>
              <p className="tabular mt-3 text-3xl font-semibold">
                {state.couponQuantity} <span className="text-sm font-normal text-muted-foreground">coupons</span>
              </p>
              <p className="mt-1 text-sm text-muted-foreground">
                {issued ? `Issued ${formatDateTime(state.issuedAt)} by ${state.issuedByName ?? "unknown"}` : "Not collected yet"}
              </p>
              {isAdmin && (
                <div className="mt-3 flex flex-wrap gap-1.5 border-t pt-3">
                  {issued && <RevertIssuanceButton teamId={team.id} meal={m} />}
                  <AdjustQuantityButton teamId={team.id} meal={m} quantity={state.couponQuantity} />
                </div>
              )}
            </article>
          );
        })}
      </section>

      <section className="rounded-xl border bg-card">
        <h2 className="border-b px-4 py-3 text-sm font-semibold">History</h2>
        <AuditList rows={history} />
      </section>
    </div>
  );
}

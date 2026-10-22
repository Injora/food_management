import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRight, Upload, Users } from "lucide-react";

import { AutoRefresh } from "@/components/auto-refresh";
import { EmptyState } from "@/components/empty-state";
import { MEAL_ICONS } from "@/components/meal-icon";
import { PageHeader } from "@/components/page-header";
import { ProgressBar } from "@/components/progress-bar";
import { StatTile } from "@/components/stat-tile";
import { Button } from "@/components/ui/button";
import { getDb } from "@/db";
import { formatNumber, formatPercent, formatTime } from "@/lib/format";
import { MEAL_LABELS } from "@/lib/meals";
import { requireActor } from "@/server/auth/current";
import { getDashboardStats, type MealStats } from "@/server/services/stats";

export const metadata: Metadata = { title: "Dashboard" };

export default async function DashboardPage() {
  const actor = await requireActor();
  const stats = await getDashboardStats(getDb(), actor);

  return (
    <div className="flex flex-col gap-6">
      <AutoRefresh seconds={15} />
      <PageHeader title="Dashboard" description="Live distribution status. Refreshes every 15 seconds." />

      {stats.totalTeams === 0 ? (
        <EmptyState icon={Users} title="No teams yet">
          {actor.role === "admin" ? (
            <>
              Import the registration CSV to get started.
              <div className="mt-4">
                <Button nativeButton={false} render={<Link href="/import" />}>
                  <Upload /> Import teams
                </Button>
              </div>
            </>
          ) : (
            "An admin needs to import the team list before coupons can be issued."
          )}
        </EmptyState>
      ) : (
        <>
          <section aria-label="Totals" className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <StatTile label="Teams" value={formatNumber(stats.totalTeams)} hint="registered teams" />
            <StatTile label="Participants" value={formatNumber(stats.totalParticipants)} hint="registered members" />
            <StatTile
              label="Coupons issued today"
              value={formatNumber(stats.couponsIssuedToday)}
              hint={`${formatNumber(stats.couponsIssuedTotal)} of ${formatNumber(stats.couponsExpectedTotal)} coupons overall`}
            />
            <div className="rounded-xl border bg-card p-4">
              <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">Overall progress</p>
              <p className="tabular mt-1.5 text-2xl font-semibold tracking-tight">{formatPercent(stats.overallProgress)}</p>
              <ProgressBar value={stats.overallProgress} label="Team-meals issued" className="mt-2" />
              <p className="mt-1.5 text-xs text-muted-foreground">of all team meals collected</p>
            </div>
          </section>

          <section aria-label="Meals" className="grid gap-4 lg:grid-cols-3">
            {stats.meals.map((m) => (
              <MealCard key={m.meal} stats={m} />
            ))}
          </section>

          <section className="rounded-xl border bg-card">
            <div className="flex items-center justify-between border-b px-4 py-3">
              <h2 className="text-sm font-semibold">Latest issuances</h2>
            </div>
            {stats.recent.length === 0 ? (
              <p className="px-4 py-8 text-center text-sm text-muted-foreground">No coupons issued yet.</p>
            ) : (
              <ul className="divide-y">
                {stats.recent.map((r) => {
                  const Icon = MEAL_ICONS[r.meal];
                  return (
                    <li key={`${r.teamId}-${r.meal}`} className="flex items-center gap-3 px-4 py-2.5 text-sm">
                      <Icon className="size-4 shrink-0 text-muted-foreground" aria-label={MEAL_LABELS[r.meal]} />
                      <Link href={`/teams/${r.teamId}`} className="min-w-0 flex-1 truncate font-medium hover:underline">
                        {r.teamName} <span className="font-mono text-xs font-normal text-muted-foreground">{r.teamCode}</span>
                      </Link>
                      <span className="tabular shrink-0 text-muted-foreground">
                        {r.couponQuantity} coupons · {formatTime(r.issuedAt)}
                        <span className="hidden sm:inline"> · {r.issuedByName ?? "unknown"}</span>
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        </>
      )}
    </div>
  );
}

function MealCard({ stats: m }: { stats: MealStats }) {
  const Icon = MEAL_ICONS[m.meal];
  const progress = m.eligibleTeams === 0 ? 0 : m.issuedTeams / m.eligibleTeams;
  return (
    <article className="flex flex-col rounded-xl border bg-card">
      <header className="flex items-center gap-3 border-b px-4 py-3">
        <span className="flex size-9 items-center justify-center rounded-lg bg-accent text-accent-foreground">
          <Icon className="size-4.5" aria-hidden />
        </span>
        <div className="flex-1">
          <h2 className="font-semibold">{MEAL_LABELS[m.meal]}</h2>
          <p className="text-xs text-muted-foreground">Last issued {m.lastIssuedAt ? formatTime(m.lastIssuedAt) : "—"}</p>
        </div>
        <Button variant="outline" size="sm" nativeButton={false} render={<Link href={`/meals/${m.meal}`} />}>
          Open <ArrowRight />
        </Button>
      </header>
      <div className="flex flex-col gap-4 p-4">
        <div>
          <div className="flex items-baseline justify-between">
            <p className="tabular text-3xl font-semibold tracking-tight">
              {m.issuedTeams}
              <span className="text-base font-normal text-muted-foreground"> / {m.eligibleTeams} teams</span>
            </p>
            <p className="tabular text-sm font-medium text-muted-foreground">{formatPercent(progress)}</p>
          </div>
          <ProgressBar value={progress} label={`${MEAL_LABELS[m.meal]} teams collected`} className="mt-2" />
        </div>
        <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
          <div className="col-span-2 text-[11px] font-semibold tracking-wider text-muted-foreground uppercase">Teams</div>
          <Metric label="Collected" value={m.issuedTeams} tone="success" />
          <Metric label="Pending" value={m.pendingTeams} tone="warning" />
          <div className="col-span-2 mt-1 text-[11px] font-semibold tracking-wider text-muted-foreground uppercase">Coupons</div>
          <Metric label="Expected" value={m.couponsExpected} />
          <Metric label="Issued" value={m.couponsIssued} tone="success" />
          <Metric label="Remaining" value={m.couponsRemaining} tone="warning" className="col-span-2" />
        </dl>
      </div>
    </article>
  );
}

function Metric({ label, value, tone, className }: { label: string; value: number; tone?: "success" | "warning"; className?: string }) {
  return (
    <div className={`flex items-center justify-between rounded-lg bg-muted/60 px-3 py-2 ${className ?? ""}`}>
      <dt className="text-muted-foreground">{label}</dt>
      <dd
        className={`tabular font-semibold ${tone === "success" ? "text-success-foreground" : tone === "warning" ? "text-warning-foreground" : ""}`}
      >
        {formatNumber(value)}
      </dd>
    </div>
  );
}

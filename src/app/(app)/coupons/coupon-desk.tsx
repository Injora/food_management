"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useMemo, useState } from "react";
import { LoaderCircle, Plus, Search, Ticket, Users } from "lucide-react";
import { cn } from "cn";

import { useBoard } from "@/components/board-context";
import { nextPending, useCouponActions } from "@/components/coupon-grid";
import { EmptyState } from "@/components/empty-state";
import { NativeSelect } from "@/components/native-select";
import { CheckInBadge, CouponBadge } from "@/components/ops-badges";
import { PageHeader } from "@/components/page-header";
import { ProgressBar } from "@/components/progress-bar";
import { useTeamPanel } from "@/components/team-panel";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { COUPON_LABELS, COUPON_TYPES, isCouponType, type CouponType } from "@/lib/domain";
import { searchTeams } from "@/lib/team-search";
import type { TeamState } from "@/server/services/board";

const PAGE_SIZE = 40;

function CouponRow({ team, meal }: { team: TeamState; meal: CouponType }) {
  const { allowed } = useBoard();
  const { openTeam } = useTeamPanel();
  const { pending, issueNext, askIssueAll, dialog } = useCouponActions(team);
  const left = team.size - team.coupons[meal];
  const next = nextPending(team, meal);
  const canIssue = allowed("coupons:issue");
  return (
    <tr className={cn("hover:bg-muted/30", left === 0 && "bg-success-soft/30")}>
      <td className="max-w-72 px-3 py-2">
        <button type="button" className="block max-w-full truncate text-left font-semibold text-primary hover:underline" onClick={() => openTeam(team.id, "coupons")}>
          {team.name}
        </button>
        <span className="text-xs text-muted-foreground">{team.leaderName ?? "—"}</span>
      </td>
      <td data-label="Present" className="px-3 py-2">
        <CheckInBadge present={team.present} size={team.size} status={team.status} compact />
      </td>
      <td data-label={`${COUPON_LABELS[meal]} issued`} className="px-3 py-2">
        <CouponBadge issued={team.coupons[meal]} entitled={team.size} label={COUPON_LABELS[meal]} />
      </td>
      <td className="px-3 py-2">
        {left === 0 ? (
          <span className="text-sm font-semibold text-success-foreground">All issued</span>
        ) : canIssue ? (
          <div className="flex flex-wrap gap-1.5 md:justify-end">
            <Button size="sm" variant="outline" disabled={pending !== null} onClick={() => void issueNext(meal)} title={next ? `Next: ${next.name}` : undefined}>
              {pending?.startsWith(`${meal}:`) && pending !== `${meal}:all` ? <LoaderCircle className="animate-spin" /> : <Plus />} 1
              {next && <span className="max-w-28 truncate font-normal text-muted-foreground">{next.name.split(" ")[0]}</span>}
            </Button>
            <Button size="sm" disabled={pending !== null} onClick={() => askIssueAll(meal)}>
              {pending === `${meal}:all` ? <LoaderCircle className="animate-spin" /> : <Ticket />} Issue all {left}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => openTeam(team.id, "coupons")}>
              <Users /> Members
            </Button>
          </div>
        ) : (
          <span className="text-sm text-muted-foreground">{left} pending</span>
        )}
        {dialog}
      </td>
    </tr>
  );
}

export function CouponDesk() {
  const { board } = useBoard();
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const meal: CouponType = isCouponType(params.get("meal")) ? (params.get("meal") as CouponType) : "lunch";
  const filter = (["pending", "complete", "all"] as const).find((f) => f === params.get("show")) ?? "pending";
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(0);

  const setParam = (k: string, v: string) => {
    const next = new URLSearchParams(params.toString());
    next.set(k, v);
    router.replace(`${pathname}?${next}`, { scroll: false });
    setPage(0);
  };

  const issued = board.couponTotals[meal];
  const entitled = board.teams.reduce((s, t) => s + t.size, 0);
  const complete = board.teams.filter((t) => t.size > 0 && t.coupons[meal] >= t.size).length;

  const visible = useMemo(() => {
    let list = searchTeams(board.teams, query);
    if (filter === "pending") list = list.filter((t) => t.coupons[meal] < t.size);
    if (filter === "complete") list = list.filter((t) => t.coupons[meal] >= t.size);
    return list;
  }, [board.teams, query, filter, meal]);
  const pageCount = Math.max(1, Math.ceil(visible.length / PAGE_SIZE));
  const current = Math.min(page, pageCount - 1);

  return (
    <div className="flex flex-col gap-5">
      <PageHeader title="Food coupons" description="One coupon per registered member per meal. The database refuses a second coupon for the same person and meal." />
      <nav aria-label="Meal" className="flex w-fit rounded-lg border bg-card p-1">
        {COUPON_TYPES.map((m) => (
          <button
            key={m}
            type="button"
            onClick={() => setParam("meal", m)}
            aria-current={m === meal ? "page" : undefined}
            className={cn("rounded-md px-4 py-1.5 text-sm font-medium", m === meal ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted")}
          >
            {COUPON_LABELS[m]} <span className="tabular opacity-80">{board.couponTotals[m]}</span>
          </button>
        ))}
      </nav>

      <section className="grid grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)] gap-2 sm:grid-cols-3 sm:gap-3">
        <div className="rounded-xl border bg-card p-3 sm:col-span-2 sm:p-4">
          <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">{COUPON_LABELS[meal]} coupons issued</p>
          <p className="tabular mt-1 text-2xl font-semibold sm:text-3xl">
            {issued}
            <span className="text-sm font-normal text-muted-foreground sm:text-base"> / {entitled}<span className="hidden sm:inline"> entitled</span></span>
          </p>
          <ProgressBar value={entitled ? issued / entitled : 0} label={`${COUPON_LABELS[meal]} coupons issued`} className="mt-2" />
        </div>
        <div className="rounded-xl border bg-card p-3 sm:p-4">
          <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">Teams complete</p>
          <p className="tabular mt-1 text-2xl font-semibold sm:text-3xl">
            {complete}
            <span className="text-sm font-normal text-muted-foreground sm:text-base"> / {board.teams.length}</span>
          </p>
        </div>
      </section>

      <div className="flex flex-wrap gap-2">
        <div className="relative w-full sm:w-auto sm:min-w-64 sm:flex-1">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <Input value={query} onChange={(e) => { setQuery(e.target.value); setPage(0); }} placeholder="Search team, leader or member…" className="h-10 pl-9" aria-label="Search teams" autoFocus />
        </div>
        <NativeSelect value={filter} onChange={(e) => setParam("show", e.target.value)} className="w-full sm:w-60" aria-label="Show">
          <option value="pending">Teams with pending {COUPON_LABELS[meal].toLowerCase()}</option>
          <option value="complete">Teams fully issued</option>
          <option value="all">All teams</option>
        </NativeSelect>
      </div>

      {visible.length === 0 ? (
        <EmptyState icon={Ticket} title={filter === "pending" && !query ? `Every team has its ${COUPON_LABELS[meal].toLowerCase()} coupons` : "No teams match"} />
      ) : (
        <div className="overflow-x-auto rounded-xl border bg-card">
          <table className="stack-table w-full text-sm">
            <thead className="border-b bg-muted/40 text-muted-foreground">
              <tr>
                <th className="px-3 py-2 text-left font-medium">Team</th>
                <th className="px-3 py-2 text-left font-medium">Present</th>
                <th className="px-3 py-2 text-left font-medium">{COUPON_LABELS[meal]} issued</th>
                <th className="px-3 py-2 text-right font-medium">Issue</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {visible.slice(current * PAGE_SIZE, (current + 1) * PAGE_SIZE).map((t) => (
                <CouponRow key={t.id} team={t} meal={meal} />
              ))}
            </tbody>
          </table>
          {pageCount > 1 && (
            <div className="flex items-center justify-between border-t px-3 py-2 text-sm text-muted-foreground">
              <span>
                Page {current + 1} of {pageCount} · {visible.length} teams
              </span>
              <div className="flex gap-1">
                <Button size="sm" variant="outline" disabled={current === 0} onClick={() => setPage(current - 1)}>
                  Previous
                </Button>
                <Button size="sm" variant="outline" disabled={current >= pageCount - 1} onClick={() => setPage(current + 1)}>
                  Next
                </Button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

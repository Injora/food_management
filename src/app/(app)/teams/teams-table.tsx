"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { ChevronLeft, ChevronRight, CircleCheckBig, Clock, Search, Users } from "lucide-react";

import { EmptyState } from "@/components/empty-state";
import { MEAL_ICONS } from "@/components/meal-icon";
import { NativeSelect } from "@/components/native-select";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { MEAL_LABELS, MEAL_TYPES } from "@/lib/meals";
import type { TeamWithMeals } from "@/server/services/teams";

const PAGE_SIZE = 50;
const squash = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");

export function TeamsTable({ teams }: { teams: TeamWithMeals[] }) {
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<"name" | "size_desc" | "size_asc" | "collected">("name");
  const [page, setPage] = useState(0);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    const qs = squash(q);
    const list = teams.filter(
      (t) =>
        !q ||
        (qs && (squash(t.teamName).includes(qs) || squash(t.teamCode).includes(qs))) ||
        t.leaderName?.toLowerCase().includes(q) ||
        t.leaderEmail?.includes(q),
    );
    const collected = (t: TeamWithMeals) => MEAL_TYPES.filter((m) => t.meals[m]?.status === "issued").length;
    return list.sort((a, b) => {
      if (sort === "size_desc") return b.memberCount - a.memberCount || a.teamName.localeCompare(b.teamName);
      if (sort === "size_asc") return a.memberCount - b.memberCount || a.teamName.localeCompare(b.teamName);
      if (sort === "collected") return collected(a) - collected(b) || a.teamName.localeCompare(b.teamName);
      return a.teamName.localeCompare(b.teamName);
    });
  }, [teams, query, sort]);

  const pageCount = Math.max(1, Math.ceil(visible.length / PAGE_SIZE));
  const current = Math.min(page, pageCount - 1);
  const rows = visible.slice(current * PAGE_SIZE, (current + 1) * PAGE_SIZE);

  if (teams.length === 0) {
    return <EmptyState icon={Users} title="No teams yet">Import a CSV or add a team to get started.</EmptyState>;
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-2 sm:flex-row">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4.5 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <Input
            type="search"
            aria-label="Search teams"
            placeholder="Search name, code, leader or email"
            className="h-11 pl-10 text-base md:text-sm"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setPage(0);
            }}
          />
        </div>
        <NativeSelect aria-label="Sort" className="sm:w-52" value={sort} onChange={(e) => setSort(e.target.value as typeof sort)}>
          <option value="name">Sort: Team name</option>
          <option value="collected">Sort: Fewest meals collected</option>
          <option value="size_desc">Sort: Largest teams</option>
          <option value="size_asc">Sort: Smallest teams</option>
        </NativeSelect>
      </div>

      {visible.length === 0 ? (
        <EmptyState icon={Search} title="No matching teams" />
      ) : (
        <div className="overflow-x-auto rounded-xl border bg-card">
          <table className="w-full text-sm">
            <thead className="border-b bg-muted/50 text-left text-xs font-medium tracking-wide text-muted-foreground uppercase">
              <tr>
                <th scope="col" className="px-4 py-2 font-medium">Team</th>
                <th scope="col" className="hidden px-4 py-2 font-medium md:table-cell">Leader</th>
                <th scope="col" className="px-4 py-2 text-right font-medium">Members</th>
                {MEAL_TYPES.map((m) => (
                  <th key={m} scope="col" className="px-2 py-2 text-center font-medium">
                    <span className="hidden sm:inline">{MEAL_LABELS[m]}</span>
                    <span className="sm:hidden">{MEAL_LABELS[m][0]}</span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y">
              {rows.map((t) => (
                <tr key={t.id} className="hover:bg-muted/40">
                  <td className="max-w-0 px-4 py-2.5">
                    <Link href={`/teams/${t.id}`} className="block truncate font-medium hover:underline">
                      {t.teamName}
                    </Link>
                    <span className="font-mono text-xs text-muted-foreground">{t.teamCode}</span>
                  </td>
                  <td className="hidden max-w-0 px-4 py-2.5 md:table-cell">
                    <span className="block truncate">{t.leaderName ?? "—"}</span>
                    <span className="block truncate text-xs text-muted-foreground">{t.leaderEmail}</span>
                  </td>
                  <td className="tabular px-4 py-2.5 text-right font-medium">{t.memberCount}</td>
                  {MEAL_TYPES.map((m) => {
                    const issued = t.meals[m]?.status === "issued";
                    const Icon = issued ? CircleCheckBig : Clock;
                    return (
                      <td key={m} className="px-2 py-2.5 text-center">
                        <Icon
                          className={issued ? "mx-auto size-4.5 text-success" : "mx-auto size-4.5 text-warning"}
                          aria-label={`${MEAL_LABELS[m]}: ${issued ? "issued" : "pending"}`}
                        />
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
          {pageCount > 1 && (
            <div className="flex items-center justify-between border-t px-4 py-2 text-sm">
              <span className="tabular text-muted-foreground">
                {current * PAGE_SIZE + 1}–{Math.min((current + 1) * PAGE_SIZE, visible.length)} of {visible.length}
              </span>
              <div className="flex gap-1">
                <Button variant="outline" size="icon" aria-label="Previous page" disabled={current === 0} onClick={() => setPage(current - 1)}>
                  <ChevronLeft />
                </Button>
                <Button variant="outline" size="icon" aria-label="Next page" disabled={current >= pageCount - 1} onClick={() => setPage(current + 1)}>
                  <ChevronRight />
                </Button>
              </div>
            </div>
          )}
        </div>
      )}
      <p className="flex items-center gap-3 text-xs text-muted-foreground">
        {MEAL_TYPES.map((m) => {
          const Icon = MEAL_ICONS[m];
          return (
            <span key={m} className="inline-flex items-center gap-1">
              <Icon className="size-3.5" aria-hidden /> {MEAL_LABELS[m]}
            </span>
          );
        })}
        <span className="inline-flex items-center gap-1"><CircleCheckBig className="size-3.5 text-success" aria-hidden /> issued</span>
        <span className="inline-flex items-center gap-1"><Clock className="size-3.5 text-warning" aria-hidden /> pending</span>
      </p>
    </div>
  );
}

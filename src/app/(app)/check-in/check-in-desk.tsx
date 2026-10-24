"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Search, UserCheck } from "lucide-react";
import { cn } from "cn";

import { useBoard } from "@/components/board-context";
import { CheckInList } from "@/components/check-in-list";
import { EmptyState } from "@/components/empty-state";
import { CheckInBadge } from "@/components/ops-badges";
import { PageHeader } from "@/components/page-header";
import { useTeamPanel } from "@/components/team-panel";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { summarize } from "@/lib/summary";
import { searchTeams } from "@/lib/team-search";

/**
 * Fast desk flow: type → ↑/↓ → Enter selects the team → tick the members who
 * are here (or 1–9), or press A / "Check in entire team" when all are present.
 * "/" jumps back to the search box.
 */
export function CheckInDesk() {
  const { board } = useBoard();
  const { openTeam } = useTeamPanel();
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const s = summarize(board);

  const results = useMemo(() => (query.trim() ? searchTeams(board.teams, query).slice(0, 12) : []), [board.teams, query]);
  const selected = board.teams.find((t) => t.id === selectedId) ?? null;
  const active = Math.min(cursor, Math.max(0, results.length - 1));

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (e.key === "/" && !["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName)) {
        e.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const choose = (id: string) => {
    setSelectedId(id);
    searchRef.current?.blur();
  };

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="Check-in"
        description={`${s.present} of ${s.participants} participants checked in · ${s.teamsFull} teams complete, ${s.teamsPartial} partial, ${s.teamsNone} not in`}
      />
      <div className="grid gap-5 lg:grid-cols-[minmax(0,22rem)_minmax(0,1fr)]">
        <div className="flex flex-col gap-2">
          <div className="relative">
            <Search className="pointer-events-none absolute top-1/2 left-3 size-5 -translate-y-1/2 text-muted-foreground" aria-hidden />
            <Input
              ref={searchRef}
              autoFocus
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setCursor(0);
              }}
              onKeyDown={(e) => {
                if (e.key === "ArrowDown") {
                  e.preventDefault();
                  setCursor((c) => Math.min(c + 1, results.length - 1));
                } else if (e.key === "ArrowUp") {
                  e.preventDefault();
                  setCursor((c) => Math.max(c - 1, 0));
                } else if (e.key === "Enter" && results[active]) {
                  e.preventDefault();
                  choose(results[active].id);
                } else if (e.key === "Escape") {
                  setQuery("");
                }
              }}
              placeholder="Team, leader or member name…"
              className="h-12 pl-10 text-base"
              aria-label="Search teams to check in"
            />
          </div>
          {query.trim() && results.length === 0 && <p className="px-1 py-4 text-sm text-muted-foreground">No team matches “{query}”.</p>}
          <ul className="flex flex-col gap-1" role="listbox" aria-label="Matching teams">
            {results.map((t, i) => (
              <li key={t.id} role="option" aria-selected={t.id === selectedId}>
                <button
                  type="button"
                  onClick={() => choose(t.id)}
                  className={cn(
                    "flex w-full items-center gap-2 rounded-lg border bg-card px-3 py-2 text-left hover:bg-muted/60",
                    i === active && "ring-2 ring-ring/50",
                    t.id === selectedId && "border-primary",
                  )}
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">{t.name}</span>
                    <span className="block truncate text-xs text-muted-foreground">
                      {t.leaderName ?? "no leader"} · {t.members.filter((m) => !m.withdrawn).map((m) => m.name.split(" ")[0]).join(", ")}
                    </span>
                  </span>
                  <CheckInBadge present={t.present} size={t.size} status={t.status} compact />
                </button>
              </li>
            ))}
          </ul>
          {!query.trim() && <p className="px-1 text-sm text-muted-foreground">Type to find a team. Press “/” anytime to come back here.</p>}
        </div>

        <div>
          {selected ? (
            <div className="flex flex-col gap-3 rounded-xl border bg-card p-4">
              <CheckInList team={selected} size="lg" keyboard />
              <div className="flex flex-wrap gap-2 border-t pt-3">
                <Button variant="outline" onClick={() => openTeam(selected.id, "coupons")}>
                  Coupons
                </Button>
                <Button variant="outline" onClick={() => openTeam(selected.id, "rooms")}>
                  Rooms
                </Button>
                <Button variant="ghost" onClick={() => { setSelectedId(null); searchRef.current?.focus(); }}>
                  Next team
                </Button>
              </div>
            </div>
          ) : (
            <EmptyState icon={UserCheck} title="Select a team">
              Opening a team never marks anyone present. Tick each person who is at the desk, or use “Check in entire team” when everyone is here.
            </EmptyState>
          )}
        </div>
      </div>
    </div>
  );
}

"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowDown, ArrowUp, ChevronLeft, ChevronRight, DoorOpen, Search, Ticket, UserCheck, Users, X } from "lucide-react";

import { useBoard } from "@/components/board-context";
import { EmptyState } from "@/components/empty-state";
import { NativeSelect } from "@/components/native-select";
import { CheckInBadge, CouponBadge, RoomBadge } from "@/components/ops-badges";
import { PageHeader } from "@/components/page-header";
import { useTeamPanel } from "@/components/team-panel";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { COUPON_LABELS, COUPON_TYPES, SESSION_IDS } from "@/lib/domain";
import { searchTeams } from "@/lib/team-search";
import type { TeamState } from "@/server/services/board";

const PAGE_SIZE = 25;

const FILTERS = {
  status: { all: "Any check-in", none: "Not checked in", partial: "Partially checked in", full: "Fully checked in" },
  room: {
    all: "Any rooms",
    talks_none: "No talk room",
    talks_set: "Has talk room",
    hackathon_none: "No hackathon room",
    hackathon_set: "Has hackathon room",
    hackathon_partial: "Hackathon: not all seated",
  },
  coupon: {
    all: "Any coupons",
    lunch_pending: "Lunch pending",
    snacks_pending: "Snacks pending",
    dinner_pending: "Dinner pending",
    complete: "All coupons issued",
  },
} as const;

const SORTS = {
  name: (a: TeamState, b: TeamState) => a.name.localeCompare(b.name),
  leader: (a: TeamState, b: TeamState) => (a.leaderName ?? "").localeCompare(b.leaderName ?? ""),
  size: (a: TeamState, b: TeamState) => a.size - b.size,
  checkin: (a: TeamState, b: TeamState) => a.present / (a.size || 1) - b.present / (b.size || 1) || a.present - b.present,
  lunch: (a: TeamState, b: TeamState) => a.coupons.lunch - b.coupons.lunch,
  snacks: (a: TeamState, b: TeamState) => a.coupons.snacks - b.coupons.snacks,
  dinner: (a: TeamState, b: TeamState) => a.coupons.dinner - b.coupons.dinner,
  talks: (a: TeamState, b: TeamState) => (a.rooms.talks?.roomNumber ?? "~").localeCompare(b.rooms.talks?.roomNumber ?? "~"),
  hackathon: (a: TeamState, b: TeamState) => (a.rooms.hackathon?.roomNumber ?? "~").localeCompare(b.rooms.hackathon?.roomNumber ?? "~"),
} as const;
type SortKey = keyof typeof SORTS;

function pick<T extends string>(value: string | null, allowed: readonly T[], fallback: T): T {
  return value && (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
}

function applyFilters(teams: TeamState[], f: { status: string; room: string; coupon: string }) {
  return teams.filter((t) => {
    if (f.status !== "all" && t.status !== f.status) return false;
    if (f.room !== "all") {
      const [session, kind] = f.room.split("_") as ["talks" | "hackathon", string];
      const r = t.rooms[session];
      if (kind === "none" && r) return false;
      if (kind === "set" && !r) return false;
      if (kind === "partial" && (!r || r.allocated >= t.size)) return false;
    }
    if (f.coupon === "complete") return COUPON_TYPES.every((c) => t.coupons[c] >= t.size);
    if (f.coupon !== "all") {
      const meal = f.coupon.replace("_pending", "") as (typeof COUPON_TYPES)[number];
      return t.coupons[meal] < t.size;
    }
    return true;
  });
}

/**
 * All filter, sort and page state lives in the URL, so it survives refreshes,
 * the back button and opening a team, and can be shared between desks.
 */
export function TeamsTable({ actions }: { actions?: React.ReactNode }) {
  const { board } = useBoard();
  const { openTeam } = useTeamPanel();
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const searchRef = useRef<HTMLInputElement>(null);

  const q = params.get("q") ?? "";
  // Local text keeps typing smooth; the URL follows it.
  const [text, setText] = useState(q);
  const status = pick(params.get("status"), Object.keys(FILTERS.status) as (keyof typeof FILTERS.status)[], "all");
  const room = pick(params.get("room"), Object.keys(FILTERS.room) as (keyof typeof FILTERS.room)[], "all");
  const coupon = pick(params.get("coupon"), Object.keys(FILTERS.coupon) as (keyof typeof FILTERS.coupon)[], "all");
  const sort = pick(params.get("sort"), Object.keys(SORTS) as SortKey[], "name");
  const dir = params.get("dir") === "desc" ? "desc" : "asc";
  const page = Math.max(0, Number(params.get("page") ?? 0) || 0);

  const update = (patch: Record<string, string | null>, resetPage = true) => {
    const next = new URLSearchParams(params.toString());
    for (const [k, v] of Object.entries(patch)) {
      if (v === null || v === "" || v === "all" || (k === "sort" && v === "name") || (k === "dir" && v === "asc")) next.delete(k);
      else next.set(k, v);
    }
    if (resetPage) next.delete("page");
    router.replace(`${pathname}${next.size ? `?${next}` : ""}`, { scroll: false });
  };

  // Deep link: /teams?team=<id> opens that team's panel.
  const teamParam = params.get("team");
  useEffect(() => {
    if (teamParam) openTeam(teamParam);
  }, [teamParam, openTeam]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (e.key === "/" && !["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName)) {
        e.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const visible = useMemo(() => {
    const filtered = applyFilters(searchTeams(board.teams, q), { status, room, coupon });
    if (q.trim() && sort === "name") return filtered; // keep relevance order while searching
    const sorted = [...filtered].sort((a, b) => SORTS[sort](a, b) || a.name.localeCompare(b.name));
    return dir === "desc" ? sorted.reverse() : sorted;
  }, [board.teams, q, status, room, coupon, sort, dir]);

  const pageCount = Math.max(1, Math.ceil(visible.length / PAGE_SIZE));
  const current = Math.min(page, pageCount - 1);
  const rows = visible.slice(current * PAGE_SIZE, (current + 1) * PAGE_SIZE);
  const participants = board.teams.reduce((s, t) => s + t.size, 0);
  const filtered = q || status !== "all" || room !== "all" || coupon !== "all";

  const sortHead = (k: SortKey, label: React.ReactNode) => (
    <th key={k} className="px-3 py-2 text-left font-medium whitespace-nowrap" aria-sort={sort === k ? (dir === "asc" ? "ascending" : "descending") : "none"}>
      <button type="button" className="inline-flex items-center gap-1 hover:text-foreground" onClick={() => update({ sort: k, dir: sort === k && dir === "asc" ? "desc" : "asc" }, false)}>
        {label}
        {sort === k && (dir === "asc" ? <ArrowUp className="size-3.5" /> : <ArrowDown className="size-3.5" />)}
      </button>
    </th>
  );

  return (
    <>
      <PageHeader title="Teams" description={`${board.teams.length} teams · ${participants} participants`} actions={actions} />
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative w-full sm:w-auto sm:min-w-64 sm:flex-1">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <Input
            ref={searchRef}
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              update({ q: e.target.value });
            }}
            placeholder="Search team, leader, member, email or phone  ( / )"
            className="h-10 pl-9"
            aria-label="Search teams"
          />
        </div>
        <NativeSelect value={status} onChange={(e) => update({ status: e.target.value })} aria-label="Check-in filter" className="w-full sm:w-48">
          {Object.entries(FILTERS.status).map(([v, l]) => (
            <option key={v} value={v}>
              {l}
            </option>
          ))}
        </NativeSelect>
        <NativeSelect value={room} onChange={(e) => update({ room: e.target.value })} aria-label="Room filter" className="w-full sm:w-52">
          {Object.entries(FILTERS.room).map(([v, l]) => (
            <option key={v} value={v}>
              {l}
            </option>
          ))}
        </NativeSelect>
        <NativeSelect value={coupon} onChange={(e) => update({ coupon: e.target.value })} aria-label="Coupon filter" className="w-full sm:w-44">
          {Object.entries(FILTERS.coupon).map(([v, l]) => (
            <option key={v} value={v}>
              {l}
            </option>
          ))}
        </NativeSelect>
        {filtered && (
          <Button
            variant="ghost"
            onClick={() => {
              setText("");
              router.replace(pathname, { scroll: false });
            }}
          >
            <X /> Clear
          </Button>
        )}
      </div>

      {visible.length === 0 ? (
        <EmptyState icon={Users} title={board.teams.length === 0 ? "No teams yet" : "No teams match"}>
          {board.teams.length === 0 ? "Import the registration file first." : "Try another search or clear the filters."}
        </EmptyState>
      ) : (
        <div className="overflow-x-auto rounded-xl border bg-card">
          <table className="stack-table w-full text-sm">
            <thead className="border-b bg-muted/40 text-muted-foreground">
              <tr>
                {sortHead("name", "Team name")}
                {sortHead("leader", "Team leader")}
                {sortHead("size", "Size")}
                {sortHead("checkin", "Check-in")}
                {COUPON_TYPES.map((c) => sortHead(c, COUPON_LABELS[c]))}
                {sortHead("talks", "Talk room")}
                {sortHead("hackathon", "Hackathon room")}
                <th className="px-3 py-2 text-right font-medium">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {rows.map((t) => (
                <tr key={t.id} className="hover:bg-muted/30">
                  <td className="max-w-64 px-3 py-2">
                    <button type="button" className="block max-w-full truncate text-left font-semibold text-primary hover:underline" onClick={() => openTeam(t.id)}>
                      {t.name}
                    </button>
                    <span className="font-mono text-xs text-muted-foreground">{t.code}</span>
                  </td>
                  <td data-label="Leader" className="max-w-48 truncate px-3 py-2">{t.leaderName ?? <span className="text-muted-foreground">—</span>}</td>
                  <td data-label="Size" className="tabular px-3 py-2">{t.size}</td>
                  <td data-label="Check-in" className="px-3 py-2">
                    <CheckInBadge present={t.present} size={t.size} status={t.status} />
                  </td>
                  {COUPON_TYPES.map((c) => (
                    <td key={c} data-label={COUPON_LABELS[c]} className="px-3 py-2">
                      <CouponBadge issued={t.coupons[c]} entitled={t.size} label={COUPON_LABELS[c]} />
                    </td>
                  ))}
                  {SESSION_IDS.map((s) => (
                    <td key={s} data-label={s === "talks" ? "Talk room" : "Hackathon room"} className="px-3 py-2">
                      <RoomBadge room={t.rooms[s]} size={t.size} />
                    </td>
                  ))}
                  <td className="px-3 py-2">
                    <div className="flex justify-end gap-1">
                      <Button size="icon-sm" variant="ghost" aria-label={`Check in ${t.name}`} title="Check-in" onClick={() => openTeam(t.id, "checkin")}>
                        <UserCheck />
                      </Button>
                      <Button size="icon-sm" variant="ghost" aria-label={`Coupons for ${t.name}`} title="Coupons" onClick={() => openTeam(t.id, "coupons")}>
                        <Ticket />
                      </Button>
                      <Button size="icon-sm" variant="ghost" aria-label={`Rooms for ${t.name}`} title="Rooms" onClick={() => openTeam(t.id, "rooms")}>
                        <DoorOpen />
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="flex items-center justify-between border-t px-3 py-2 text-sm text-muted-foreground">
            <span>
              {visible.length} team{visible.length === 1 ? "" : "s"}
              {filtered && ` of ${board.teams.length}`} · page {current + 1} of {pageCount}
            </span>
            <div className="flex gap-1">
              <Button size="icon-sm" variant="outline" aria-label="Previous page" disabled={current === 0} onClick={() => update({ page: String(current - 1) }, false)}>
                <ChevronLeft />
              </Button>
              <Button size="icon-sm" variant="outline" aria-label="Next page" disabled={current >= pageCount - 1} onClick={() => update({ page: String(current + 1) }, false)}>
                <ChevronRight />
              </Button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

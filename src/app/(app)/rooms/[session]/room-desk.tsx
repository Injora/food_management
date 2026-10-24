"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { DoorOpen, Mic, Search } from "lucide-react";
import { cn } from "cn";

import { AllocationForm } from "@/components/allocation-form";
import { useBoard } from "@/components/board-context";
import { EmptyState } from "@/components/empty-state";
import { CheckInBadge, RoomBadge } from "@/components/ops-badges";
import { RoomCard } from "@/components/room-card";
import { useTeamPanel } from "@/components/team-panel";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { effectiveMax, isLimited } from "@/lib/capacity";
import { SESSION_IDS, SESSION_LABELS, type SessionId } from "@/lib/domain";
import { searchTeams } from "@/lib/team-search";

const timeFmt = new Intl.DateTimeFormat("en-IN", {
  timeZone: process.env.NEXT_PUBLIC_EVENT_TIMEZONE || "Asia/Kolkata",
  day: "numeric",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

export function RoomDesk({ session }: { session: SessionId }) {
  const { board } = useBoard();
  const { openTeam } = useTeamPanel();
  const [query, setQuery] = useState("");
  const [teamId, setTeam] = useState<string | null>(null);
  // Picking a team from the cards or table below brings the form into view.
  const setTeamId = (id: string) => {
    setTeam(id);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const info = board.sessions.find((s) => s.id === session);
  const rooms = board.rooms.filter((r) => r.sessionId === session);
  const occupancy = rooms.reduce((s, r) => s + r.occupancy, 0);
  const limited = rooms.filter(isLimited);
  const unlimited = limited.length < rooms.length;
  const nominal = limited.reduce((s, r) => s + r.nominalCapacity, 0);
  const max = limited.reduce((s, r) => s + effectiveMax(r), 0);
  const tolerances = [...new Set(rooms.map((r) => r.overflowTolerance))];
  const results = useMemo(() => (query.trim() ? searchTeams(board.teams, query).slice(0, 8) : []), [board.teams, query]);
  const team = board.teams.find((t) => t.id === teamId) ?? null;
  const assigned = board.teams.filter((t) => t.rooms[session]).length;

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Room allocation</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {info && `${SESSION_LABELS[session]}: ${timeFmt.format(new Date(info.startsAt))} – ${timeFmt.format(new Date(info.endsAt))}`} ·{" "}
            {unlimited
              ? `${occupancy} participants from ${assigned} teams seated · no room capacity limit`
              : `${occupancy}/${nominal} seated (max ${max}) · ${assigned} teams · tolerance ${tolerances.join("/")} per room`}
          </p>
        </div>
        <nav aria-label="Session" className="flex w-fit rounded-lg border bg-card p-1">
          {SESSION_IDS.map((s) => {
            const Icon = s === "talks" ? Mic : DoorOpen;
            return (
              <Link
                key={s}
                href={`/rooms/${s}`}
                aria-current={s === session ? "page" : undefined}
                className={cn("flex items-center gap-1.5 rounded-md px-4 py-1.5 text-sm font-medium", s === session ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted")}
              >
                <Icon className="size-4" aria-hidden /> {SESSION_LABELS[s]}
              </Link>
            );
          })}
        </nav>
      </div>

      <section className="grid gap-4 rounded-xl border bg-card p-4 lg:grid-cols-[minmax(0,20rem)_minmax(0,1fr)]">
        <div className="flex flex-col gap-2">
          <h2 className="text-sm font-semibold">1. Find the team</h2>
          <div className="relative">
            <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && results[0]) setTeamId(results[0].id);
              }}
              placeholder="Team, leader or member…"
              className="h-10 pl-9"
              aria-label="Search teams to allocate"
              autoFocus
            />
          </div>
          <ul className="flex flex-col gap-1">
            {results.map((t) => (
              <li key={t.id}>
                <button
                  type="button"
                  onClick={() => setTeamId(t.id)}
                  className={cn("flex w-full items-center gap-2 rounded-lg border px-3 py-2 text-left hover:bg-muted/60", t.id === teamId && "border-primary bg-accent/40")}
                >
                  <span className="min-w-0 flex-1 truncate font-medium">{t.name}</span>
                  <CheckInBadge present={t.present} size={t.size} status={t.status} compact />
                  <RoomBadge room={t.rooms[session]} size={t.size} />
                </button>
              </li>
            ))}
          </ul>
        </div>
        <div className="flex flex-col gap-2">
          <h2 className="text-sm font-semibold">2. Choose members and a room</h2>
          {team ? (
            <>
              <p className="text-base font-semibold">
                {team.name} <span className="font-mono text-xs font-normal text-muted-foreground">{team.code}</span>
              </p>
              <AllocationForm key={team.id} session={session} team={team} />
            </>
          ) : (
            <p className="rounded-lg border border-dashed px-4 py-8 text-center text-sm text-muted-foreground">
              {unlimited
                ? "Search for a team. Talk rooms have no capacity limit: allocate wherever you think best. Present members are preselected."
                : "Search for a team. Capacity is counted in people: a team of 4 uses 4 seats. Present members are preselected."}
            </p>
          )}
        </div>
      </section>

      {rooms.length === 0 ? (
        <EmptyState icon={DoorOpen} title="No rooms configured">
          An admin can add rooms in Settings.
        </EmptyState>
      ) : (
        <section aria-label="Live room occupancy" className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {rooms.map((r) => (
            <RoomCard key={r.id} room={r} onTeamClick={(id) => setTeamId(id)} />
          ))}
        </section>
      )}

      <section className="rounded-xl border bg-card">
        <h2 className="border-b px-4 py-3 text-sm font-semibold">Teams by room</h2>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="border-b bg-muted/40 text-muted-foreground">
              <tr>
                <th className="px-3 py-2 text-left font-medium">Room</th>
                <th className="px-3 py-2 text-left font-medium">Team</th>
                <th className="px-3 py-2 text-left font-medium">Seated</th>
                <th className="px-3 py-2 text-left font-medium">Check-in</th>
                <th className="px-3 py-2 text-right font-medium">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {rooms.flatMap((r) =>
                r.teams.map((rt) => {
                  const t = board.teams.find((x) => x.id === rt.teamId);
                  return (
                    <tr key={`${r.id}-${rt.teamId}`}>
                      <td className="px-3 py-2 font-semibold">{r.roomNumber}</td>
                      <td className="px-3 py-2">{rt.teamName}</td>
                      <td className="tabular px-3 py-2">
                        {rt.allocated}/{rt.size}
                      </td>
                      <td className="px-3 py-2">{t && <CheckInBadge present={t.present} size={t.size} status={t.status} compact />}</td>
                      <td className="px-3 py-2 text-right">
                        <Button size="sm" variant="outline" onClick={() => setTeamId(rt.teamId)}>
                          Move / release
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => openTeam(rt.teamId, "rooms")}>
                          Details
                        </Button>
                      </td>
                    </tr>
                  );
                }),
              )}
              {assigned === 0 && (
                <tr>
                  <td colSpan={5} className="px-3 py-6 text-center text-muted-foreground">
                    No teams allocated yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

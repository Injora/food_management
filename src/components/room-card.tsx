"use client";

import { useState } from "react";
import { Search, TriangleAlert, Users } from "lucide-react";
import { cn } from "cn";

import { Pill, type Tone } from "@/components/ops-badges";
import { effectiveMax, hardRemaining, isLimited, nominalRemaining, roomLevel, ROOM_LEVEL_LABELS, type RoomLevel } from "@/lib/capacity";
import type { RoomState } from "@/server/services/board";

export const LEVEL_TONE: Record<RoomLevel, Tone> = { open: "success", near: "warning", full: "warning", overflow: "danger", max: "danger", unlimited: "neutral" };
const BAR: Record<RoomLevel, string> = { open: "bg-success", near: "bg-warning", full: "bg-warning", overflow: "bg-destructive", max: "bg-destructive", unlimited: "bg-primary" };

/** Occupancy bar scaled to the hard limit, with a tick at nominal capacity. Rooms without a limit have no bar. */
export function OccupancyBar({ room, className }: { room: RoomState; className?: string }) {
  if (!isLimited(room)) return null;
  const max = effectiveMax(room);
  const level = roomLevel(room);
  const pct = Math.min(100, (room.occupancy / max) * 100);
  const nominalPct = (room.nominalCapacity / max) * 100;
  return (
    <div
      role="meter"
      aria-label={`Room ${room.roomNumber} occupancy`}
      aria-valuemin={0}
      aria-valuemax={max}
      aria-valuenow={room.occupancy}
      aria-valuetext={`${room.occupancy} of ${room.nominalCapacity} participants`}
      className={cn("relative h-2.5 w-full overflow-hidden rounded-full bg-muted", className)}
    >
      <div className={cn("h-full rounded-full transition-[width]", BAR[level])} style={{ width: `${pct}%` }} />
      {room.overflowTolerance > 0 && (
        <div className="absolute inset-y-0 w-0.5 bg-foreground/40" style={{ left: `${nominalPct}%` }} title="Nominal capacity" />
      )}
    </div>
  );
}

function TeamList({ room, onTeamClick, searchable }: { room: RoomState; onTeamClick?: (teamId: string) => void; searchable: boolean }) {
  const [q, setQ] = useState("");
  const teams = q.trim() ? room.teams.filter((t) => t.teamName.toLowerCase().includes(q.trim().toLowerCase()) || t.teamCode.toLowerCase().includes(q.trim().toLowerCase())) : room.teams;
  return (
    <div className="border-t pt-2">
      <p className="mb-1 flex items-center gap-1.5 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
        <Users className="size-3.5" aria-hidden /> Assigned teams
      </p>
      {searchable && room.teams.length > 5 && (
        <div className="relative mb-1.5">
          <Search className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Find a team in this room"
            aria-label={`Search teams in Room ${room.roomNumber}`}
            className="h-8 w-full rounded-md border border-input bg-background pr-2 pl-7 text-sm outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
          />
        </div>
      )}
      {room.teams.length === 0 ? (
        <p className="text-sm text-muted-foreground">No teams yet.</p>
      ) : teams.length === 0 ? (
        <p className="text-sm text-muted-foreground">No team matches.</p>
      ) : (
        <ul className="flex max-h-56 flex-col gap-0.5 overflow-y-auto text-sm">
          {teams.map((t) => (
            <li key={t.teamId} className="flex items-center justify-between gap-2">
              {onTeamClick ? (
                <button type="button" className="truncate text-left hover:underline" onClick={() => onTeamClick(t.teamId)}>
                  {t.teamName}
                </button>
              ) : (
                <span className="truncate">{t.teamName}</span>
              )}
              <span className="tabular shrink-0 text-muted-foreground" title={`${t.allocated} of ${t.size} members seated`}>
                {t.allocated}/{t.size}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function RoomCard({ room, showTeams = true, onTeamClick }: { room: RoomState; showTeams?: boolean; onTeamClick?: (teamId: string) => void }) {
  if (!isLimited(room)) {
    // Open-source talk rooms: no limit, so show live counts only — never remaining slots.
    return (
      <article className="flex flex-col gap-3 rounded-xl border bg-card p-4">
        <header className="flex items-start justify-between gap-2">
          <h3 className="text-lg font-semibold tracking-tight">Room {room.roomNumber}</h3>
          <Pill t="neutral">{ROOM_LEVEL_LABELS.unlimited}</Pill>
        </header>
        <dl className="tabular grid grid-cols-2 gap-3">
          <div className="rounded-lg bg-muted/60 px-3 py-2">
            <dt className="text-xs text-muted-foreground">Teams</dt>
            <dd className="text-2xl font-semibold">{room.teams.length}</dd>
          </div>
          <div className="rounded-lg bg-muted/60 px-3 py-2">
            <dt className="text-xs text-muted-foreground">Participants</dt>
            <dd className="text-2xl font-semibold">{room.occupancy}</dd>
          </div>
        </dl>
        {showTeams && <TeamList room={room} onTeamClick={onTeamClick} searchable />}
      </article>
    );
  }

  const level = roomLevel(room);
  const pct = Math.round((room.occupancy / room.nominalCapacity) * 100);
  const over = room.occupancy - room.nominalCapacity;
  return (
    <article
      className={cn(
        "flex flex-col gap-3 rounded-xl border bg-card p-4",
        level === "max" && "border-destructive/60 ring-2 ring-destructive/30",
        level === "overflow" && "border-destructive/40",
        (level === "near" || level === "full") && "border-warning/60",
      )}
    >
      <header className="flex items-start justify-between gap-2">
        <div>
          <h3 className="text-lg font-semibold tracking-tight">Room {room.roomNumber}</h3>
          <p className="tabular text-2xl font-semibold">
            {room.occupancy}
            <span className="text-base font-normal text-muted-foreground"> / {room.nominalCapacity} participants</span>
          </p>
        </div>
        <Pill t={LEVEL_TONE[level]}>
          {(level === "overflow" || level === "max") && <TriangleAlert aria-hidden />}
          {ROOM_LEVEL_LABELS[level]}
        </Pill>
      </header>
      <OccupancyBar room={room} />
      <dl className="tabular grid grid-cols-2 gap-x-3 gap-y-1 text-sm">
        <dt className="text-muted-foreground">Slots remaining</dt>
        <dd className="text-right font-medium">{nominalRemaining(room)}</dd>
        <dt className="text-muted-foreground">Occupied</dt>
        <dd className="text-right font-medium">{pct}%</dd>
        <dt className="text-muted-foreground">Teams</dt>
        <dd className="text-right font-medium">{room.teams.length}</dd>
        <dt className="text-muted-foreground">Overflow allowance</dt>
        <dd className="text-right font-medium">{room.overflowTolerance}</dd>
        <dt className="text-muted-foreground">Maximum permitted</dt>
        <dd className="text-right font-medium">
          {effectiveMax(room)} <span className="text-muted-foreground">({hardRemaining(room)} left)</span>
        </dd>
      </dl>
      {over > 0 && (
        <p className="rounded-lg bg-destructive/10 px-2.5 py-1.5 text-xs font-medium text-destructive">
          {over} over nominal capacity{level === "max" ? " — no more allocations possible" : ` (tolerance ${room.overflowTolerance})`}
        </p>
      )}
      {showTeams && <TeamList room={room} onTeamClick={onTeamClick} searchable={false} />}
    </article>
  );
}

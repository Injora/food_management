"use client";

import { useMemo, useState } from "react";
import { ArrowRightLeft, CircleCheckBig, DoorOpen, LoaderCircle, OctagonAlert, TriangleAlert, X } from "lucide-react";
import { cn } from "cn";

import { useBoard, useRun } from "@/components/board-context";
import { Pill } from "@/components/ops-badges";
import { OccupancyBar } from "@/components/room-card";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { capacityErrorMessage, effectiveMax, evaluateFit, hardRemaining, isLimited, nominalRemaining, suggestRooms } from "@/lib/capacity";
import { SESSION_LABELS, type SessionId } from "@/lib/domain";
import type { ActionError } from "@/lib/errors";
import { allocateTeamAction, moveTeamAction, releaseAllocationAction } from "@/server/actions/ops";
import type { RoomState, TeamState } from "@/server/services/board";
import type { CapacityErrorDetails } from "@/server/services/rooms";

type Mode = "allocate" | "move";

/** Prominent, actionable capacity error, built from the server's details. */
export function CapacityError({
  error,
  onPick,
  onDismiss,
}: {
  error: ActionError;
  onPick?: (roomId: string) => void;
  onDismiss?: () => void;
}) {
  const d = error.details as CapacityErrorDetails | undefined;
  const { title, message } = d ? capacityErrorMessage(d.roomNumber, d.overflowTolerance) : { title: "Maximum capacity reached.", message: error.message };
  return (
    <div role="alert" className="relative flex flex-col gap-3 rounded-xl border-2 border-destructive bg-destructive/10 p-4 text-destructive">
      {onDismiss && (
        <Button variant="ghost" size="icon-sm" className="absolute top-2 right-2 text-destructive" onClick={onDismiss} aria-label="Dismiss">
          <X />
        </Button>
      )}
      <div className="flex items-start gap-3 pr-6">
        <OctagonAlert className="mt-0.5 size-6 shrink-0" aria-hidden />
        <div>
          <p className="text-base font-bold">{title}</p>
          <p className="mt-0.5 text-sm font-medium">{message}</p>
        </div>
      </div>
      {d && (
        <dl className="tabular grid grid-cols-2 gap-x-4 gap-y-0.5 rounded-lg bg-background/70 px-3 py-2 text-sm text-foreground sm:grid-cols-4">
          <div>
            <dt className="text-xs text-muted-foreground">Room {d.roomNumber} now</dt>
            <dd className="font-semibold">
              {d.occupancy}/{d.nominalCapacity}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">Slots remaining</dt>
            <dd className="font-semibold">{Math.max(0, d.nominalCapacity - d.occupancy)}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">Max permitted</dt>
            <dd className="font-semibold">
              {d.effectiveMax} ({Math.max(0, d.effectiveMax - d.occupancy)} left)
            </dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">This allocation</dt>
            <dd className="font-semibold">
              {d.requested} → {d.projected}/{d.nominalCapacity}
            </dd>
          </div>
        </dl>
      )}
      {d &&
        (d.alternatives.length > 0 ? (
          <div className="text-foreground">
            <p className="mb-1.5 text-sm font-semibold">Rooms with space for {d.requested}:</p>
            <div className="flex flex-wrap gap-2">
              {d.alternatives.map((a) => (
                <Button key={a.roomId} variant="outline" size="lg" onClick={() => onPick?.(a.roomId)} disabled={!onPick}>
                  <DoorOpen /> Room {a.roomNumber}
                  <span className="tabular text-muted-foreground">
                    {a.nominalCapacity === null ? `${a.occupancy} people` : `${a.occupancy}/${a.nominalCapacity} · ${Math.max(0, a.nominalCapacity - a.occupancy)} left`}
                  </span>
                  {a.decision === "overflow" && <Pill t="warning">uses tolerance</Pill>}
                </Button>
              ))}
            </div>
          </div>
        ) : (
          <p className="rounded-lg bg-background/70 px-3 py-2 text-sm font-semibold">
            No room in this session has space for {d.requested} participant{d.requested === 1 ? "" : "s"}. Do not seat this team; ask the
            organizer to free space or add a room.
          </p>
        ))}
    </div>
  );
}

function RoomOption({
  room,
  incoming,
  selected,
  recommended,
  onSelect,
}: {
  room: RoomState;
  incoming: number;
  selected: boolean;
  recommended: boolean;
  onSelect: () => void;
}) {
  const fit = evaluateFit(room, incoming);
  if (!isLimited(room)) {
    // Talk rooms: no limit, just the live counts.
    return (
      <button
        type="button"
        onClick={onSelect}
        aria-pressed={selected}
        className={cn(
          "flex flex-col gap-1 rounded-lg border bg-card p-2.5 text-left transition-colors outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50",
          selected && "border-primary ring-2 ring-primary/40",
        )}
      >
        <span className="font-semibold">Room {room.roomNumber}</span>
        <span className="tabular text-sm">
          {room.teams.length} teams · {room.occupancy} participants
        </span>
        {incoming > 0 && <span className="text-xs font-medium text-muted-foreground">→ {fit.projected} participants</span>}
      </button>
    );
  }
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className={cn(
        "flex flex-col gap-1.5 rounded-lg border bg-card p-2.5 text-left transition-colors outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50",
        selected && "border-primary ring-2 ring-primary/40",
        fit.decision === "reject" && "opacity-75",
      )}
    >
      <span className="flex items-center justify-between gap-2">
        <span className="font-semibold">Room {room.roomNumber}</span>
        {recommended && fit.decision === "fits" && <Pill t="success">Best fit</Pill>}
      </span>
      <span className="tabular text-sm">
        {room.occupancy}/{room.nominalCapacity} · <span className="text-muted-foreground">{nominalRemaining(room)} left</span>
      </span>
      <OccupancyBar room={room} className="h-1.5" />
      <span
        className={cn(
          "text-xs font-medium",
          fit.decision === "fits" && "text-success-foreground",
          fit.decision === "overflow" && "text-warning-foreground",
          fit.decision === "reject" && "text-destructive",
        )}
      >
        {incoming === 0
          ? `max ${effectiveMax(room)}`
          : fit.decision === "fits"
            ? `Fits → ${fit.projected}/${room.nominalCapacity}`
            : fit.decision === "overflow"
              ? `Over nominal → ${fit.projected}/${room.nominalCapacity}`
              : `No space (${hardRemaining(room)} left incl. tolerance)`}
      </span>
    </button>
  );
}

/**
 * Room allocation for one team in one session: choose the members (present
 * members are preselected), choose a room, confirm. The server re-checks
 * capacity inside a locked transaction; this screen only previews it.
 */
export function AllocationForm({ session, team, onDone }: { session: SessionId; team: TeamState; onDone?: () => void }) {
  const { board, allowed } = useBoard();
  const { run, pending } = useRun();
  const rooms = useMemo(() => board.rooms.filter((r) => r.sessionId === session), [board.rooms, session]);
  const members = team.members.filter((m) => !m.withdrawn);
  const current = team.rooms[session];
  const seated = members.filter((m) => m.rooms[session]);
  const unseated = members.filter((m) => !m.rooms[session]);

  const [mode, setMode] = useState<Mode>("allocate");
  const [selected, setSelected] = useState<Set<string>>(() => new Set(unseated.filter((m) => m.checkIn).map((m) => m.id)));
  const [roomId, setRoomId] = useState<string | null>(current?.roomId ?? null);
  const [error, setError] = useState<ActionError | null>(null);

  // Members that this action adds to the target room.
  const chosen = unseated.filter((m) => selected.has(m.id));
  const incoming = mode === "move" ? seated.length + chosen.length : chosen.length;
  const targetRooms = mode === "move" ? rooms.filter((r) => r.id !== current?.roomId) : current ? rooms.filter((r) => r.id === current.roomId) : rooms;
  const best = suggestRooms(targetRooms, incoming)[0]?.room.id ?? null;
  const target = rooms.find((r) => r.id === (mode === "move" ? roomId : (current?.roomId ?? roomId))) ?? null;
  const fit = target ? evaluateFit(target, incoming) : null;

  const toggle = (id: string) =>
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const onCapacity = (e: ActionError) => {
    if (e.code === "CAPACITY_EXCEEDED" || e.code === "ALREADY_ASSIGNED") {
      setError(e);
      return true;
    }
    return false;
  };

  const submit = async () => {
    if (!target || incoming === 0) return;
    setError(null);
    const res =
      mode === "move"
        ? await run(
            "move",
            () => moveTeamAction({ sessionId: session, teamId: team.id, toRoomId: target.id, participantIds: [...seated.map((m) => m.id), ...chosen.map((m) => m.id)] }),
            { success: (r) => `${team.name} moved to Room ${r.roomNumber} (${r.occupancy}/${r.nominalCapacity}).`, onError: onCapacity },
          )
        : await run(
            "allocate",
            () => allocateTeamAction({ sessionId: session, teamId: team.id, roomId: target.id, participantIds: chosen.map((m) => m.id) }),
            {
              success: (r) =>
                `${r.added} from ${team.name} → Room ${r.roomNumber}. Now ${r.occupancy}/${r.nominalCapacity}${r.overNominal ? " (over nominal, within tolerance)" : ""}.`,
              onError: onCapacity,
            },
          );
    if (res?.ok) {
      setSelected(new Set());
      setMode("allocate");
      onDone?.();
    }
  };

  const release = (participantIds?: string[]) =>
    run("release", () => releaseAllocationAction({ sessionId: session, teamId: team.id, participantIds }), {
      success: (r) => `Released ${r.released} seat${r.released === 1 ? "" : "s"} from Room ${current?.roomNumber}.`,
    });

  if (members.length === 0) return <p className="text-sm text-muted-foreground">This team has no active members.</p>;
  const canAllocate = allowed("rooms:allocate");
  const canReassign = allowed("rooms:reassign");

  return (
    <div className="flex flex-col gap-3">
      {current ? (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border bg-muted/40 px-3 py-2">
          <DoorOpen className="size-4.5 text-muted-foreground" aria-hidden />
          <p className="text-sm">
            In <span className="font-semibold">Room {current.roomNumber}</span> ·{" "}
            <span className="tabular">
              {current.allocated}/{team.size} members seated
            </span>
          </p>
          <div className="ml-auto flex gap-1.5">
            {canReassign && (
              <Button variant={mode === "move" ? "secondary" : "outline"} size="sm" onClick={() => { setMode(mode === "move" ? "allocate" : "move"); setRoomId(null); setError(null); }}>
                <ArrowRightLeft /> {mode === "move" ? "Cancel move" : "Move"}
              </Button>
            )}
            {canReassign && (
              <Button variant="destructive" size="sm" disabled={pending !== null} onClick={() => release()}>
                Release all
              </Button>
            )}
          </div>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">Not allocated for {SESSION_LABELS[session]}.</p>
      )}

      <fieldset className="flex flex-col gap-1">
        <legend className="mb-1 flex w-full items-center justify-between text-xs font-semibold tracking-wide text-muted-foreground uppercase">
          <span>{mode === "move" ? "Also seat (optional)" : current ? "Add members to this room" : "Members to allocate"}</span>
          {unseated.length > 0 && (
            <span className="flex gap-2 normal-case">
              <button type="button" className="text-primary hover:underline" onClick={() => setSelected(new Set(unseated.filter((m) => m.checkIn).map((m) => m.id)))}>
                Present only
              </button>
              <button type="button" className="text-primary hover:underline" onClick={() => setSelected(new Set(unseated.map((m) => m.id)))}>
                All
              </button>
            </span>
          )}
        </legend>
        {members.map((m) => {
          const isSeated = !!m.rooms[session];
          return (
            <label key={m.id} className={cn("flex min-h-9 items-center gap-2.5 rounded-md px-2 text-sm hover:bg-muted/60", isSeated && "text-muted-foreground")}>
              <Checkbox checked={isSeated || selected.has(m.id)} disabled={isSeated || !canAllocate} onCheckedChange={() => toggle(m.id)} />
              <span className="flex-1 truncate">
                {m.name}
                {m.isLeader && <span className="ml-1 text-xs text-muted-foreground">(leader)</span>}
              </span>
              {m.checkIn ? <Pill t="success">present</Pill> : <Pill t="neutral">not checked in</Pill>}
              {isSeated && (
                <span className="flex items-center gap-1 text-xs">
                  seated
                  {canReassign && (
                    <Button variant="ghost" size="icon-xs" aria-label={`Release ${m.name}`} title="Release this seat" disabled={pending !== null} onClick={(e) => { e.preventDefault(); void release([m.id]); }}>
                      <X />
                    </Button>
                  )}
                </span>
              )}
            </label>
          );
        })}
        {chosen.some((m) => !m.checkIn) && (
          <p className="flex items-center gap-1.5 text-xs text-warning-foreground">
            <TriangleAlert className="size-3.5" aria-hidden /> Some selected members are not checked in.
          </p>
        )}
      </fieldset>

      {(mode === "move" || !current) && (
        <div>
          <p className="mb-1.5 text-xs font-semibold tracking-wide text-muted-foreground uppercase">{mode === "move" ? "Move to" : "Room"}</p>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {targetRooms.map((r) => (
              <RoomOption key={r.id} room={r} incoming={incoming} selected={roomId === r.id} recommended={r.id === best} onSelect={() => { setRoomId(r.id); setError(null); }} />
            ))}
          </div>
        </div>
      )}

      {error && error.code === "CAPACITY_EXCEEDED" && (
        <CapacityError
          error={error}
          onDismiss={() => setError(null)}
          onPick={(id) => {
            // From a full current room, picking another room becomes a move.
            if (current) setMode("move");
            setRoomId(id);
            setError(null);
          }}
        />
      )}
      {error && error.code === "ALREADY_ASSIGNED" && (
        <p role="alert" className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm font-medium text-destructive">
          {error.message}
        </p>
      )}

      {canAllocate && (
        <div className="flex flex-wrap items-center gap-2">
          <Button size="lg" className="h-10 px-4" disabled={!target || incoming === 0 || pending !== null} onClick={submit}>
            {pending === "allocate" || pending === "move" ? <LoaderCircle className="animate-spin" /> : <CircleCheckBig />}
            {!target
              ? "Choose a room"
              : incoming === 0
                ? "Select members"
                : mode === "move"
                  ? `Move ${incoming} to Room ${target.roomNumber}`
                  : `Allocate ${incoming} to Room ${target.roomNumber}`}
          </Button>
          {fit?.decision === "overflow" && (
            <Pill t="warning">
              <TriangleAlert aria-hidden /> Exceeds nominal ({fit.projected}/{target!.nominalCapacity}) but within the {target!.overflowTolerance}-person tolerance
            </Pill>
          )}
          {fit?.decision === "reject" && (
            <Pill t="danger">
              <OctagonAlert aria-hidden /> Not enough space — the server will refuse this
            </Pill>
          )}
        </div>
      )}
    </div>
  );
}

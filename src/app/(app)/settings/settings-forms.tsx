"use client";

import { useState } from "react";
import { LoaderCircle, Plus, Save, Trash2 } from "lucide-react";

import { useBoard, useRun } from "@/components/board-context";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { effectiveMax } from "@/lib/capacity";
import { SESSION_IDS, SESSION_LABELS, type SessionId } from "@/lib/domain";
import { createRoomAction, deleteRoomAction, updateRoomAction, updateSessionAction } from "@/server/actions/teams";
import type { RoomState, SessionState } from "@/server/services/board";

/** ISO instant -> value for <input type="datetime-local"> in the browser's zone. */
function toLocalInput(iso: string) {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function SessionForm({ session, rooms }: { session: SessionState; rooms: RoomState[] }) {
  const { run, pending } = useRun();
  const tolerances = [...new Set(rooms.map((r) => r.overflowTolerance))];
  const [name, setName] = useState(session.name);
  const [startsAt, setStartsAt] = useState(toLocalInput(session.startsAt));
  const [endsAt, setEndsAt] = useState(toLocalInput(session.endsAt));
  const [tolerance, setTolerance] = useState(String(tolerances[0] ?? 3));

  return (
    <form
      className="grid gap-3 sm:grid-cols-2 lg:grid-cols-[2fr_1.3fr_1.3fr_1fr_auto] lg:items-end"
      onSubmit={(e) => {
        e.preventDefault();
        void run(
          "session",
          () =>
            updateSessionAction({
              sessionId: session.id,
              name,
              startsAt: new Date(startsAt).toISOString(),
              endsAt: new Date(endsAt).toISOString(),
              overflowTolerance: Number(tolerance),
            }),
          { success: () => `${name} saved` },
        );
      }}
    >
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`${session.id}-name`}>Name</Label>
        <Input id={`${session.id}-name`} value={name} onChange={(e) => setName(e.target.value)} required maxLength={120} />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`${session.id}-start`}>Starts</Label>
        <Input id={`${session.id}-start`} type="datetime-local" value={startsAt} onChange={(e) => setStartsAt(e.target.value)} required />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`${session.id}-end`}>Ends</Label>
        <Input id={`${session.id}-end`} type="datetime-local" value={endsAt} onChange={(e) => setEndsAt(e.target.value)} required />
      </div>
      {session.id === "talks" ? (
        <p className="text-sm text-muted-foreground">Talk rooms have no capacity limit.</p>
      ) : (
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${session.id}-tol`}>Overflow tolerance (all rooms)</Label>
          <Input id={`${session.id}-tol`} type="number" min={0} max={50} value={tolerance} onChange={(e) => setTolerance(e.target.value)} required />
        </div>
      )}
      <Button type="submit" variant="outline" className="h-8" disabled={pending !== null}>
        {pending === "session" ? <LoaderCircle className="animate-spin" /> : <Save />} Save session
      </Button>
      {session.id !== "talks" && tolerances.length > 1 && <p className="text-xs text-warning-foreground sm:col-span-2 lg:col-span-5">Rooms currently use different tolerances ({tolerances.join(", ")}). Saving applies {tolerance} to every room.</p>}
    </form>
  );
}

function RoomRow({ room }: { room: RoomState }) {
  if (room.nominalCapacity === null) return <UnlimitedRoomRow room={room} />;
  return <LimitedRoomRow room={room} nominalCapacity={room.nominalCapacity} />;
}

/** Open-source talk rooms: no capacity to edit. */
function UnlimitedRoomRow({ room }: { room: RoomState }) {
  const { run, pending } = useRun();
  return (
    <tr>
      <td className="px-3 py-2 font-semibold">{room.roomNumber}</td>
      <td className="px-3 py-2 text-muted-foreground" colSpan={3}>
        No limit
      </td>
      <td className="tabular px-3 py-2">
        {room.occupancy} people · {room.teams.length} teams
      </td>
      <td className="px-3 py-2 text-right">
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label={`Delete room ${room.roomNumber}`}
          title={room.occupancy > 0 ? "Move teams out first" : "Delete room"}
          disabled={room.occupancy > 0 || pending !== null}
          onClick={() => run("delete", () => deleteRoomAction({ roomId: room.id }), { success: () => `Room ${room.roomNumber} deleted` })}
        >
          <Trash2 />
        </Button>
      </td>
    </tr>
  );
}

function LimitedRoomRow({ room, nominalCapacity }: { room: RoomState; nominalCapacity: number }) {
  const { run, pending } = useRun();
  const [capacity, setCapacity] = useState(String(nominalCapacity));
  const [tolerance, setTolerance] = useState(String(room.overflowTolerance));
  const dirty = Number(capacity) !== nominalCapacity || Number(tolerance) !== room.overflowTolerance;
  return (
    <tr>
      <td className="px-3 py-2 font-semibold">{room.roomNumber}</td>
      <td className="px-3 py-2">
        <Input type="number" min={1} value={capacity} onChange={(e) => setCapacity(e.target.value)} className="w-24" aria-label={`Room ${room.roomNumber} capacity`} />
      </td>
      <td className="px-3 py-2">
        <Input type="number" min={0} max={50} value={tolerance} onChange={(e) => setTolerance(e.target.value)} className="w-20" aria-label={`Room ${room.roomNumber} tolerance`} />
      </td>
      <td className="tabular px-3 py-2">{effectiveMax({ nominalCapacity: Number(capacity) || 0, overflowTolerance: Number(tolerance) || 0 })}</td>
      <td className="tabular px-3 py-2">
        {room.occupancy}/{room.nominalCapacity}
      </td>
      <td className="px-3 py-2 text-right">
        <Button
          size="sm"
          variant={dirty ? "default" : "outline"}
          disabled={!dirty || pending !== null}
          onClick={() =>
            run("save", () => updateRoomAction({ roomId: room.id, nominalCapacity: Number(capacity), overflowTolerance: Number(tolerance) }), {
              success: () => `Room ${room.roomNumber} saved`,
            })
          }
        >
          {pending === "save" ? <LoaderCircle className="animate-spin" /> : <Save />} Save
        </Button>
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label={`Delete room ${room.roomNumber}`}
          title={room.occupancy > 0 ? "Move teams out first" : "Delete room"}
          disabled={room.occupancy > 0 || pending !== null}
          onClick={() => run("delete", () => deleteRoomAction({ roomId: room.id }), { success: () => `Room ${room.roomNumber} deleted` })}
        >
          <Trash2 />
        </Button>
      </td>
    </tr>
  );
}

function AddRoom({ session, defaultTolerance }: { session: SessionId; defaultTolerance: number }) {
  const { run, pending } = useRun();
  const [number, setNumber] = useState("");
  const [capacity, setCapacity] = useState("40");
  return (
    <form
      className="flex flex-wrap items-end gap-2 border-t px-3 py-3"
      onSubmit={async (e) => {
        e.preventDefault();
        const nominalCapacity = session === "talks" ? null : Number(capacity);
        const res = await run("add", () => createRoomAction({ sessionId: session, roomNumber: number, nominalCapacity, overflowTolerance: defaultTolerance }), {
          success: () => `Room ${number} added`,
        });
        if (res?.ok) setNumber("");
      }}
    >
      <div className="flex flex-col gap-1">
        <Label htmlFor={`${session}-new-room`} className="text-xs">
          Room number
        </Label>
        <Input id={`${session}-new-room`} value={number} onChange={(e) => setNumber(e.target.value)} className="w-28" required maxLength={40} />
      </div>
      {session !== "talks" && (
        <div className="flex flex-col gap-1">
          <Label htmlFor={`${session}-new-cap`} className="text-xs">
            Capacity
          </Label>
          <Input id={`${session}-new-cap`} type="number" min={1} value={capacity} onChange={(e) => setCapacity(e.target.value)} className="w-24" required />
        </div>
      )}
      <Button type="submit" size="sm" variant="outline" disabled={pending !== null}>
        <Plus /> Add room
      </Button>
    </form>
  );
}

export function SettingsForms() {
  const { board } = useBoard();
  return (
    <div className="flex flex-col gap-6">
      {SESSION_IDS.map((id) => {
        const session = board.sessions.find((s) => s.id === id);
        const rooms = board.rooms.filter((r) => r.sessionId === id);
        if (!session) return null;
        return (
          <section key={id} className="flex flex-col gap-4 rounded-xl border bg-card p-4">
            <h2 className="font-semibold">{SESSION_LABELS[id]}</h2>
            <SessionForm session={session} rooms={rooms} />
            <div className="overflow-x-auto rounded-lg border">
              <table className="w-full text-sm">
                <thead className="bg-muted/40 text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2 text-left font-medium">Room</th>
                    <th className="px-3 py-2 text-left font-medium">Nominal capacity</th>
                    <th className="px-3 py-2 text-left font-medium">Tolerance</th>
                    <th className="px-3 py-2 text-left font-medium">Max permitted</th>
                    <th className="px-3 py-2 text-left font-medium">Now</th>
                    <th className="px-3 py-2 text-right font-medium">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {rooms.map((r) => (
                    <RoomRow key={`${r.id}-${r.nominalCapacity}-${r.overflowTolerance}`} room={r} />
                  ))}
                </tbody>
              </table>
              <AddRoom session={id} defaultTolerance={rooms[0]?.overflowTolerance ?? 3} />
            </div>
            <p className="text-xs text-muted-foreground">
              A capacity or tolerance change is refused if a room already holds more people than the new limit — occupancy is never hidden by changing numbers. Times are in your browser&apos;s time zone.
            </p>
          </section>
        );
      })}
    </div>
  );
}

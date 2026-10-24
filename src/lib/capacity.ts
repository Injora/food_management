/**
 * Participant-based room capacity rules, shared by the server (which enforces
 * them inside a locked transaction) and the UI (which only previews them).
 *
 *   effective maximum = nominal capacity + overflow tolerance
 *   allow  ⇔ current occupancy + incoming participants ≤ effective maximum
 *
 * A null nominal capacity means the room is unlimited (open-source talk
 * rooms): volunteers decide how many teams go in, and nothing is rejected.
 */

export type RoomCapacity = {
  nominalCapacity: number | null;
  overflowTolerance: number;
  occupancy: number;
};

export type LimitedRoom = RoomCapacity & { nominalCapacity: number };

export const isLimited = <R extends RoomCapacity>(r: R): r is R & { nominalCapacity: number } => r.nominalCapacity !== null;

export const effectiveMax = (r: { nominalCapacity: number; overflowTolerance: number }) => r.nominalCapacity + r.overflowTolerance;

/** Seats left before the nominal capacity (never negative). */
export const nominalRemaining = (r: LimitedRoom) => Math.max(0, r.nominalCapacity - r.occupancy);

/** Seats left before the hard limit, including the tolerance (never negative). */
export const hardRemaining = (r: LimitedRoom) => Math.max(0, effectiveMax(r) - r.occupancy);

export type FitDecision = "fits" | "overflow" | "reject";

/**
 * fits:     stays within the nominal capacity
 * overflow: exceeds nominal but stays within the tolerance (allowed, warned)
 * reject:   would exceed nominal + tolerance
 */
export function evaluateFit(room: RoomCapacity, incoming: number): { decision: FitDecision; projected: number } {
  const projected = room.occupancy + incoming;
  if (!isLimited(room)) return { decision: "fits", projected };
  if (projected > effectiveMax(room)) return { decision: "reject", projected };
  if (projected > room.nominalCapacity) return { decision: "overflow", projected };
  return { decision: "fits", projected };
}

export type RoomLevel = "open" | "near" | "full" | "overflow" | "max" | "unlimited";

/**
 * open:     below 85% of nominal
 * near:     85% or more of nominal
 * full:     exactly at nominal
 * overflow: above nominal, inside the tolerance
 * max:      at the hard limit; nothing more can be allocated
 */
export function roomLevel(room: RoomCapacity): RoomLevel {
  if (!isLimited(room)) return "unlimited";
  if (room.occupancy >= effectiveMax(room)) return "max";
  if (room.occupancy > room.nominalCapacity) return "overflow";
  if (room.occupancy === room.nominalCapacity) return "full";
  if (room.nominalCapacity > 0 && room.occupancy / room.nominalCapacity >= 0.85) return "near";
  return "open";
}

export const ROOM_LEVEL_LABELS: Record<RoomLevel, string> = {
  open: "Available",
  near: "Nearly full",
  full: "Full (nominal)",
  overflow: "Over nominal — using tolerance",
  max: "FULL — limit reached",
  unlimited: "No capacity limit",
};

export type RoomOption<R extends RoomCapacity> = { room: R; decision: Exclude<FitDecision, "reject">; projected: number };

/**
 * Rooms that can take `incoming` people, best first: rooms that stay within
 * their nominal capacity come before rooms that would need the overflow
 * tolerance; within each group the room with the most space left comes first.
 */
export function suggestRooms<R extends RoomCapacity & { id: string }>(
  rooms: R[],
  incoming: number,
  excludeRoomId?: string | null,
): RoomOption<R>[] {
  const options: RoomOption<R>[] = [];
  for (const room of rooms) {
    if (room.id === excludeRoomId) continue;
    const { decision, projected } = evaluateFit(room, incoming);
    if (decision !== "reject") options.push({ room, decision, projected });
  }
  return options.sort(
    (a, b) =>
      (a.decision === "fits" ? 0 : 1) - (b.decision === "fits" ? 0 : 1) ||
      remainingForSort(b.room) - remainingForSort(a.room),
  );
}

const remainingForSort = (r: RoomCapacity) => (isLimited(r) ? hardRemaining(r) : Number.MAX_SAFE_INTEGER);

export function capacityErrorMessage(roomNumber: string, tolerance: number) {
  return {
    title: `Maximum capacity reached for Room ${roomNumber}.`,
    message:
      tolerance > 0
        ? `Room capacity limit reached, including the ${tolerance}-person tolerance. Please allocate this team to another room.`
        : "Room capacity limit reached. Please allocate this team to another room.",
  };
}

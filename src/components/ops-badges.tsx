import { CircleCheckBig, CircleDashed, CircleDot, DoorOpen } from "lucide-react";
import { cn } from "cn";

import { CHECK_IN_LABELS, type CheckInStatus } from "@/lib/domain";
import type { TeamRoom } from "@/server/services/board";

const tone = {
  success: "border-success/30 bg-success-soft text-success-foreground",
  warning: "border-warning/40 bg-warning-soft text-warning-foreground",
  danger: "border-destructive/30 bg-destructive/10 text-destructive",
  neutral: "border-border bg-muted/60 text-muted-foreground",
} as const;
export type Tone = keyof typeof tone;

export function Pill({ t, className, children, title }: { t: Tone; className?: string; children: React.ReactNode; title?: string }) {
  return (
    <span
      title={title}
      className={cn(
        "tabular inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-semibold whitespace-nowrap [&_svg]:size-3.5",
        tone[t],
        className,
      )}
    >
      {children}
    </span>
  );
}

/** "3/4 present" plus a text status, so colour is never the only signal. */
export function CheckInBadge({ present, size, status, compact }: { present: number; size: number; status: CheckInStatus; compact?: boolean }) {
  const t: Tone = status === "full" ? "success" : status === "partial" ? "warning" : "neutral";
  const Icon = status === "full" ? CircleCheckBig : status === "partial" ? CircleDot : CircleDashed;
  return (
    <Pill t={t} title={CHECK_IN_LABELS[status]}>
      <Icon aria-hidden />
      {present}/{size}
      <span className={compact ? "sr-only" : "font-medium"}>{status === "full" ? "present" : status === "partial" ? "partial" : "not in"}</span>
    </Pill>
  );
}

export function CouponBadge({ issued, entitled, label }: { issued: number; entitled: number; label: string }) {
  const t: Tone = entitled > 0 && issued >= entitled ? "success" : issued > 0 ? "warning" : "neutral";
  return (
    <Pill t={t} title={`${label}: ${issued} of ${entitled} issued`}>
      {issued >= entitled && entitled > 0 && <CircleCheckBig aria-hidden />}
      {issued}/{entitled}
    </Pill>
  );
}

export function RoomBadge({ room, size }: { room: TeamRoom | null; size: number }) {
  if (!room) return <span className="text-xs text-muted-foreground">—</span>;
  return (
    <Pill t={room.allocated >= size ? "success" : "warning"} title={`${room.allocated} of ${size} members seated`}>
      <DoorOpen aria-hidden />
      {room.roomNumber}
      <span className="font-medium">· {room.allocated}/{size}</span>
    </Pill>
  );
}

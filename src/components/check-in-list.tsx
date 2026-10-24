"use client";

import { useEffect, useState } from "react";
import { CircleCheckBig, Crown, LoaderCircle, Undo2, UserCheck } from "lucide-react";
import { cn } from "cn";

import { useBoard, useRun } from "@/components/board-context";
import { ConfirmDialog, type ConfirmRequest } from "@/components/confirm-dialog";
import { CheckInBadge } from "@/components/ops-badges";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { formatTime } from "@/lib/format";
import { checkInAction, undoCheckInAction } from "@/server/actions/ops";
import type { MemberState, TeamState } from "@/server/services/board";

/**
 * Per-member attendance. Ticking a box checks that one person in at once;
 * nobody is marked present just because the team was opened. Unticking asks
 * for confirmation and records the undo. "Check in entire team" is explicit
 * and confirmed.
 */
export function CheckInList({ team, size = "md", keyboard = false }: { team: TeamState; size?: "md" | "lg"; keyboard?: boolean }) {
  const { allowed } = useBoard();
  const { run, pending } = useRun();
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);
  const members = team.members.filter((m) => !m.withdrawn);
  const absent = members.filter((m) => !m.checkIn);
  const canWrite = allowed("checkin:write");
  const canUndo = allowed("checkin:undo");

  const checkIn = (m: MemberState) =>
    run(`m:${m.id}`, () => checkInAction({ teamId: team.id, participantIds: [m.id] }), {
      success: (r) => (r.checkedIn.length ? `${m.name} checked in · ${r.present}/${r.size} present` : `${m.name} was already checked in`),
    });

  const askUndo = (m: MemberState) =>
    setConfirm({
      title: `Undo check-in for ${m.name}?`,
      description: `Checked in ${formatTime(m.checkIn?.at)} by ${m.checkIn?.by ?? "unknown"}. The original record is kept in the audit log.`,
      confirmLabel: "Undo check-in",
      destructive: true,
      reason: "optional",
      onConfirm: async (reason) =>
        !!(await run(`m:${m.id}`, () => undoCheckInAction({ teamId: team.id, participantIds: [m.id], reason }), {
          success: (r) => `Check-in undone for ${m.name} · ${r.present}/${r.size} present`,
        }))?.ok,
    });

  const askWholeTeam = () =>
    setConfirm({
      title: `Check in all of ${team.name}?`,
      description: (
        <>
          Confirm that every member is physically at the desk:
          <ul className="mt-2 list-disc pl-5 text-foreground">
            {absent.map((m) => (
              <li key={m.id}>{m.name}</li>
            ))}
          </ul>
        </>
      ),
      confirmLabel: `Yes, all ${members.length} are present`,
      onConfirm: async () =>
        !!(await run("all", () => checkInAction({ teamId: team.id, wholeTeam: true }), {
          success: (r) => `${team.name}: ${r.present}/${r.size} present`,
        }))?.ok,
    });

  const toggle = (m: MemberState) => {
    if (pending) return;
    if (m.checkIn) {
      if (canUndo) askUndo(m);
    } else if (canWrite) {
      void checkIn(m);
    }
  };

  // Desk shortcut: number keys toggle members, "A" checks in the whole team.
  useEffect(() => {
    if (!keyboard) return;
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (confirm || e.metaKey || e.ctrlKey || e.altKey || ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName)) return;
      const n = Number(e.key);
      if (n >= 1 && n <= members.length) {
        e.preventDefault();
        toggle(members[n - 1]);
      } else if (e.key.toLowerCase() === "a" && absent.length > 0 && canWrite) {
        e.preventDefault();
        askWholeTeam();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <p className="font-semibold">
          {team.name} — {team.size} member{team.size === 1 ? "" : "s"}
        </p>
        <CheckInBadge present={team.present} size={team.size} status={team.status} />
        {canWrite && absent.length > 0 && (
          <Button className={cn("ml-auto", size === "lg" ? "h-11 px-4 text-base" : "h-9 px-3")} disabled={pending !== null} onClick={askWholeTeam}>
            {pending === "all" ? <LoaderCircle className="animate-spin" /> : <UserCheck />}
            {absent.length === members.length ? "Check in entire team" : `Mark remaining ${absent.length} present`}
            {keyboard && <kbd className="ml-1 rounded border border-primary-foreground/40 px-1 text-[10px]">A</kbd>}
          </Button>
        )}
        {absent.length === 0 && members.length > 0 && (
          <span className="ml-auto flex items-center gap-1.5 text-sm font-semibold text-success-foreground">
            <CircleCheckBig className="size-4" aria-hidden /> Whole team present
          </span>
        )}
      </div>

      <ul className="flex flex-col divide-y rounded-lg border bg-card">
        {members.map((m, i) => {
          const busy = pending === `m:${m.id}`;
          return (
            <li key={m.id}>
              <label className={cn("flex cursor-pointer items-center gap-3 px-3 hover:bg-muted/50", size === "lg" ? "min-h-14" : "min-h-11", m.checkIn && "bg-success-soft/40")}>
                {busy ? (
                  <LoaderCircle className="size-5 animate-spin text-muted-foreground" aria-label="Saving" />
                ) : (
                  <Checkbox
                    className={size === "lg" ? "size-6 [&_svg]:size-5!" : "size-5"}
                    checked={!!m.checkIn}
                    disabled={pending !== null || (m.checkIn ? !canUndo : !canWrite)}
                    onCheckedChange={() => toggle(m)}
                    aria-label={`${m.name}: ${m.checkIn ? "present (untick to undo)" : "not checked in"}`}
                  />
                )}
                {keyboard && i < 9 && <kbd className="tabular rounded border px-1.5 text-xs text-muted-foreground">{i + 1}</kbd>}
                <span className="min-w-0 flex-1">
                  <span className={cn("flex items-center gap-1.5 font-medium", size === "lg" && "text-base")}>
                    <span className="truncate">{m.name}</span>
                    {m.isLeader && <Crown className="size-3.5 shrink-0 text-warning" aria-label="Team leader" />}
                  </span>
                  <span className="block truncate text-xs text-muted-foreground">
                    {m.code}
                    {m.email && ` · ${m.email}`}
                    {m.phone && ` · ${m.phone}`}
                  </span>
                </span>
                {m.checkIn ? (
                  <span className="flex shrink-0 flex-col items-end text-xs">
                    <span className="font-semibold text-success-foreground">Present</span>
                    <span className="text-muted-foreground">
                      {formatTime(m.checkIn.at)} · {m.checkIn.by ?? "—"}
                    </span>
                  </span>
                ) : (
                  <span className="shrink-0 text-xs font-medium text-muted-foreground">Not checked in</span>
                )}
                {m.checkIn && canUndo && (
                  <Button variant="ghost" size="icon-sm" aria-label={`Undo check-in for ${m.name}`} title="Undo check-in" disabled={pending !== null} onClick={(e) => { e.preventDefault(); askUndo(m); }}>
                    <Undo2 />
                  </Button>
                )}
              </label>
            </li>
          );
        })}
        {members.length === 0 && <li className="px-3 py-6 text-center text-sm text-muted-foreground">No active members.</li>}
      </ul>
      <ConfirmDialog request={confirm} onClose={() => setConfirm(null)} />
    </div>
  );
}

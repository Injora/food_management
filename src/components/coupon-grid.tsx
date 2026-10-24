"use client";

import { useState } from "react";
import { CircleCheckBig, LoaderCircle, Plus, RotateCcw, Ticket } from "lucide-react";
import { cn } from "cn";

import { useBoard, useRun } from "@/components/board-context";
import { ConfirmDialog, type ConfirmRequest } from "@/components/confirm-dialog";
import { CouponBadge } from "@/components/ops-badges";
import { Button } from "@/components/ui/button";
import { COUPON_LABELS, COUPON_TYPES, type CouponType } from "@/lib/domain";
import { formatTime } from "@/lib/format";
import { issueCouponsAction, revertCouponAction } from "@/server/actions/ops";
import type { MemberState, TeamState } from "@/server/services/board";

/** Next member to receive a coupon: present members first, then registration order. */
export function nextPending(team: TeamState, meal: CouponType): MemberState | null {
  const pending = team.members.filter((m) => !m.withdrawn && !m.coupons[meal]);
  return pending.find((m) => m.checkIn) ?? pending[0] ?? null;
}

export function useCouponActions(team: TeamState) {
  const { run, pending } = useRun();
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);
  const label = (meal: CouponType) => COUPON_LABELS[meal].toLowerCase();

  const issueTo = (meal: CouponType, member: MemberState) =>
    run(`${meal}:${member.id}`, () => issueCouponsAction({ teamId: team.id, couponType: meal, participantIds: [member.id], requestId: crypto.randomUUID() }), {
      success: (r) => `${COUPON_LABELS[meal]} coupon → ${member.name} · ${team.name} ${r.issued}/${r.entitled}`,
    });

  const issueNext = (meal: CouponType) => {
    const m = nextPending(team, meal);
    return m ? issueTo(meal, m) : null;
  };

  const askIssueAll = (meal: CouponType) => {
    const pendingMembers = team.members.filter((m) => !m.withdrawn && !m.coupons[meal]);
    if (pendingMembers.length === 0) return;
    const go = async () =>
      !!(await run(`${meal}:all`, () => issueCouponsAction({ teamId: team.id, couponType: meal, allPending: true, requestId: crypto.randomUUID() }), {
        success: (r) => `${r.issuedTo.length} ${label(meal)} coupon${r.issuedTo.length === 1 ? "" : "s"} issued to ${team.name} · ${r.issued}/${r.entitled}`,
      }))?.ok;
    if (pendingMembers.length === 1) return void go();
    const absent = pendingMembers.filter((m) => !m.checkIn);
    setConfirm({
      title: `Issue ${pendingMembers.length} ${label(meal)} coupons to ${team.name}?`,
      description: (
        <>
          One coupon each for: {pendingMembers.map((m) => m.name).join(", ")}.
          {absent.length > 0 && (
            <span className="mt-2 block font-medium text-warning-foreground">
              Not checked in: {absent.map((m) => m.name).join(", ")}.
            </span>
          )}
        </>
      ),
      confirmLabel: `Issue ${pendingMembers.length} coupons`,
      onConfirm: go,
    });
  };

  const askRevert = (meal: CouponType, member: MemberState) => {
    const c = member.coupons[meal];
    if (!c) return;
    setConfirm({
      title: `Revert ${member.name}'s ${label(meal)} coupon?`,
      description: `Issued ${formatTime(c.at)} by ${c.by ?? "unknown"}. Only revert a coupon that was not actually handed over (or was returned). This is recorded in the audit log.`,
      confirmLabel: "Revert coupon",
      destructive: true,
      reason: "required",
      onConfirm: async (reason) =>
        !!(await run(`${meal}:${member.id}`, () => revertCouponAction({ issuanceId: c.id, reason }), {
          success: () => `${COUPON_LABELS[meal]} coupon for ${member.name} reverted`,
        }))?.ok,
    });
  };

  const dialog = <ConfirmDialog request={confirm} onClose={() => setConfirm(null)} />;
  return { pending, issueTo, issueNext, askIssueAll, askRevert, dialog };
}

/** Members × meals; every cell is one entitlement. */
export function CouponGrid({ team, meals = COUPON_TYPES }: { team: TeamState; meals?: readonly CouponType[] }) {
  const { allowed } = useBoard();
  const { pending, issueTo, issueNext, askIssueAll, askRevert, dialog } = useCouponActions(team);
  const members = team.members.filter((m) => !m.withdrawn);
  const canIssue = allowed("coupons:issue");
  const canRevert = allowed("coupons:revert");

  return (
    <div className="overflow-x-auto rounded-lg border">
      <table className="w-full text-sm">
        <thead className="bg-muted/50">
          <tr>
            <th className="px-3 py-2 text-left font-medium">Member</th>
            {meals.map((meal) => {
              const left = team.size - team.coupons[meal];
              return (
                <th key={meal} className="px-3 py-2 text-left align-top font-medium">
                  <div className="flex items-center gap-2">
                    {COUPON_LABELS[meal]} <CouponBadge issued={team.coupons[meal]} entitled={team.size} label={COUPON_LABELS[meal]} />
                  </div>
                  {canIssue && left > 0 && (
                    <div className="mt-1.5 flex gap-1">
                      <Button size="xs" variant="outline" disabled={pending !== null} onClick={() => void issueNext(meal)} title="Issue one coupon to the next member (present members first)">
                        <Plus /> 1
                      </Button>
                      <Button size="xs" disabled={pending !== null} onClick={() => askIssueAll(meal)}>
                        {pending === `${meal}:all` ? <LoaderCircle className="animate-spin" /> : <Ticket />} All {left}
                      </Button>
                    </div>
                  )}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody className="divide-y">
          {members.map((m) => (
            <tr key={m.id}>
              <td className="px-3 py-2">
                <span className="font-medium">{m.name}</span>
                <span className={cn("block text-xs", m.checkIn ? "text-success-foreground" : "text-muted-foreground")}>{m.checkIn ? "present" : "not checked in"}</span>
              </td>
              {meals.map((meal) => {
                const c = m.coupons[meal];
                const busy = pending === `${meal}:${m.id}`;
                return (
                  <td key={meal} className="px-3 py-2">
                    {c ? (
                      <span className="flex items-center gap-1">
                        <CircleCheckBig className="size-4 shrink-0 text-success" aria-hidden />
                        <span className="text-xs">
                          <span className="font-semibold text-success-foreground">Issued</span>
                          <span className="block text-muted-foreground">
                            {formatTime(c.at)} · {c.by ?? "—"}
                          </span>
                        </span>
                        {canRevert && (
                          <Button variant="ghost" size="icon-xs" className="ml-auto" aria-label={`Revert ${m.name}'s ${meal} coupon`} title="Revert (admin)" disabled={pending !== null} onClick={() => askRevert(meal, m)}>
                            {busy ? <LoaderCircle className="animate-spin" /> : <RotateCcw />}
                          </Button>
                        )}
                      </span>
                    ) : canIssue ? (
                      <Button size="sm" variant="outline" disabled={pending !== null} onClick={() => void issueTo(meal, m)}>
                        {busy ? <LoaderCircle className="animate-spin" /> : <Ticket />} Issue
                      </Button>
                    ) : (
                      <span className="text-xs text-muted-foreground">Pending</span>
                    )}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      {dialog}
    </div>
  );
}

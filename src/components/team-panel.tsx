"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { Archive, Crown, LoaderCircle, Pencil, RefreshCw, Trash2, Undo2, UserMinus, UserPlus } from "lucide-react";
import { toast } from "sonner";

import { AllocationForm } from "@/components/allocation-form";
import { AuditList } from "@/components/audit-list";
import { useBoard, useRun } from "@/components/board-context";
import { CheckInList } from "@/components/check-in-list";
import { ConfirmDialog, type ConfirmRequest } from "@/components/confirm-dialog";
import { CouponGrid } from "@/components/coupon-grid";
import { CheckInBadge, CouponBadge, RoomBadge } from "@/components/ops-badges";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { callAction } from "@/lib/client-fetch";
import { COUPON_LABELS, COUPON_TYPES, SESSION_IDS, SESSION_LABELS } from "@/lib/domain";
import {
  addParticipantAction,
  archiveTeamAction,
  deleteTeamAction,
  restoreParticipantAction,
  teamHistoryAction,
  updateParticipantAction,
  updateTeamAction,
  withdrawParticipantAction,
} from "@/server/actions/teams";
import type { AuditRow } from "@/server/services/audit";
import type { MemberState, TeamState } from "@/server/services/board";

export type PanelTab = "checkin" | "coupons" | "rooms" | "manage";

type PanelContext = { openTeam: (teamId: string, tab?: PanelTab) => void; close: () => void; openId: string | null };
const Ctx = createContext<PanelContext | null>(null);

export function useTeamPanel() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useTeamPanel must be used inside TeamPanelProvider");
  return ctx;
}

/** One team panel for the whole app; any page can open it. */
export function TeamPanelProvider({ children }: { children: React.ReactNode }) {
  const { board } = useBoard();
  const [state, setState] = useState<{ id: string; tab: PanelTab } | null>(null);
  const openTeam = useCallback((id: string, tab: PanelTab = "checkin") => setState({ id, tab }), []);
  const close = useCallback(() => setState(null), []);
  const team = state ? (board.teams.find((t) => t.id === state.id) ?? null) : null;
  const value = useMemo(() => ({ openTeam, close, openId: state?.id ?? null }), [openTeam, close, state?.id]);

  return (
    <Ctx.Provider value={value}>
      {children}
      <Sheet open={state !== null} onOpenChange={(o) => !o && close()}>
        <SheetContent side="right" className="w-full! max-w-none! gap-0 overflow-y-auto p-0 sm:max-w-3xl!">
          {state && !team && (
            <SheetHeader>
              <SheetTitle>Team not available</SheetTitle>
              <SheetDescription>This team was archived or removed.</SheetDescription>
            </SheetHeader>
          )}
          {state && team && <TeamPanel key={team.id} team={team} initialTab={state.tab} />}
        </SheetContent>
      </Sheet>
    </Ctx.Provider>
  );
}

function TeamPanel({ team, initialTab }: { team: TeamState; initialTab: PanelTab }) {
  const [tab, setTab] = useState<PanelTab>(initialTab);
  return (
    <div className="flex flex-col">
      <SheetHeader className="gap-2 border-b p-4 pr-12">
        <SheetTitle className="text-xl">{team.name}</SheetTitle>
        <SheetDescription render={<div />}>
          <span className="font-mono text-xs">{team.code}</span>
          {team.college && <> · {team.college}</>}
          {team.leaderName && <> · Leader: {team.leaderName}</>}
        </SheetDescription>
        <div className="flex flex-wrap items-center gap-1.5">
          <CheckInBadge present={team.present} size={team.size} status={team.status} />
          {COUPON_TYPES.map((c) => (
            <span key={c} className="flex items-center gap-1 text-xs text-muted-foreground">
              {COUPON_LABELS[c]} <CouponBadge issued={team.coupons[c]} entitled={team.size} label={COUPON_LABELS[c]} />
            </span>
          ))}
          {SESSION_IDS.map((s) => (
            <span key={s} className="flex items-center gap-1 text-xs text-muted-foreground">
              {s === "talks" ? "Talk" : "Hack"} <RoomBadge room={team.rooms[s]} size={team.size} />
            </span>
          ))}
        </div>
        {team.declaredMemberCount !== null && team.declaredMemberCount !== team.size && (
          <p className="text-xs text-warning-foreground">
            Registration form said {team.declaredMemberCount} members; {team.size} are registered by name. Entitlements follow the named members.
          </p>
        )}
      </SheetHeader>
      <Tabs value={tab} onValueChange={(v) => setTab(v as PanelTab)} className="flex-col p-4">
        <TabsList className="h-9 w-full shrink-0">
          <TabsTrigger value="checkin">Check-in</TabsTrigger>
          <TabsTrigger value="coupons">Coupons</TabsTrigger>
          <TabsTrigger value="rooms">Rooms</TabsTrigger>
          <TabsTrigger value="manage">Manage & history</TabsTrigger>
        </TabsList>
        <TabsContent value="checkin" className="pt-3">
          <CheckInList team={team} />
        </TabsContent>
        <TabsContent value="coupons" className="pt-3">
          <CouponGrid team={team} />
        </TabsContent>
        <TabsContent value="rooms" className="flex flex-col gap-6 pt-3">
          {SESSION_IDS.map((s) => (
            <section key={s} className="flex flex-col gap-2">
              <h3 className="font-semibold">{SESSION_LABELS[s]}</h3>
              <AllocationForm session={s} team={team} />
            </section>
          ))}
        </TabsContent>
        <TabsContent value="manage" className="flex flex-col gap-6 pt-3">
          <ManageTeam team={team} />
          <TeamHistory team={team} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Manage (admin) and history
// ---------------------------------------------------------------------------

type PersonForm = { name: string; email: string; phone: string; isLeader: boolean };

/** Mounted per edit (keyed by the caller), so the form starts from `initial`. */
function MemberDialog({
  title,
  initial,
  onClose,
  onSave,
}: {
  title: string;
  initial: PersonForm;
  onClose: () => void;
  onSave: (p: PersonForm) => Promise<boolean>;
}) {
  const [form, setForm] = useState(initial);
  const [busy, setBusy] = useState(false);
  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent className="sm:max-w-md">
        <form
          className="flex flex-col gap-3"
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            try {
              if (await onSave(form)) onClose();
            } finally {
              setBusy(false);
            }
          }}
        >
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
          </DialogHeader>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="m-name">Name</Label>
            <Input id="m-name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required maxLength={120} autoFocus />
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="m-email">Email</Label>
              <Input id="m-email" type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} maxLength={254} />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="m-phone">Phone</Label>
              <Input id="m-phone" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} maxLength={40} />
            </div>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <Checkbox checked={form.isLeader} onCheckedChange={(v) => setForm({ ...form, isLeader: !!v })} /> Team leader
          </label>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={busy}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy || !form.name.trim()}>
              {busy && <LoaderCircle className="animate-spin" />} Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ManageTeam({ team }: { team: TeamState }) {
  const { allowed } = useBoard();
  const { close } = useTeamPanel();
  const { run, pending } = useRun();
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);
  const [editing, setEditing] = useState<{ member: MemberState | null } | null>(null);
  const [name, setName] = useState(team.name);
  const [college, setCollege] = useState(team.college ?? "");
  if (!allowed("teams:edit")) {
    return <p className="text-sm text-muted-foreground">Only admins can edit registrations. Ask an admin to add, remove or correct members.</p>;
  }

  const blank: PersonForm = { name: "", email: "", phone: "", isLeader: false };
  const saveMember = async (p: PersonForm) => {
    const member = editing?.member;
    const res = member
      ? await run("member", () => updateParticipantAction({ participantId: member.id, ...p }), { success: () => `${p.name} updated` })
      : await run("member", () => addParticipantAction({ teamId: team.id, ...p }), { success: () => `${p.name} added to ${team.name}` });
    return !!res?.ok;
  };

  return (
    <section className="flex flex-col gap-4">
      <form
        className="grid gap-3 rounded-lg border p-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end"
        onSubmit={(e) => {
          e.preventDefault();
          void run("team", () => updateTeamAction({ teamId: team.id, teamName: name, college }), { success: (r) => (r.changed ? "Team updated" : "No changes") });
        }}
      >
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="t-name">Team name</Label>
          <Input id="t-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={120} required />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="t-college">College / company</Label>
          <Input id="t-college" value={college} onChange={(e) => setCollege(e.target.value)} maxLength={200} />
        </div>
        <Button type="submit" variant="outline" className="h-8" disabled={pending !== null}>
          <Pencil /> Save
        </Button>
      </form>

      <div className="rounded-lg border">
        <div className="flex items-center justify-between border-b px-3 py-2">
          <h3 className="text-sm font-semibold">Members</h3>
          <Button size="sm" variant="outline" onClick={() => setEditing({ member: null })}>
            <UserPlus /> Add member
          </Button>
        </div>
        <ul className="divide-y text-sm">
          {team.members.map((m) => (
            <li key={m.id} className={`flex items-center gap-2 px-3 py-2 ${m.withdrawn ? "text-muted-foreground line-through" : ""}`}>
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-1.5 font-medium">
                  {m.name} {m.isLeader && <Crown className="size-3.5 text-warning" aria-label="Leader" />}
                  {m.withdrawn && <span className="text-xs no-underline">(withdrawn)</span>}
                </span>
                <span className="block truncate text-xs text-muted-foreground">
                  {m.code} · {m.email ?? "no email"} · {m.phone ?? "no phone"}
                </span>
              </span>
              {m.withdrawn ? (
                <Button size="sm" variant="ghost" disabled={pending !== null} onClick={() => run("member", () => restoreParticipantAction({ participantId: m.id }), { success: () => `${m.name} restored` })}>
                  <Undo2 /> Restore
                </Button>
              ) : (
                <>
                  <Button size="icon-sm" variant="ghost" aria-label={`Edit ${m.name}`} onClick={() => setEditing({ member: m })}>
                    <Pencil />
                  </Button>
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    aria-label={`Withdraw ${m.name}`}
                    title="Withdraw from team"
                    onClick={() =>
                      setConfirm({
                        title: `Withdraw ${m.name} from ${team.name}?`,
                        description: "They stop counting towards team size, coupon entitlement and rooms; their room seats are released. Check-in and coupon history is kept. You can restore them later.",
                        confirmLabel: "Withdraw",
                        destructive: true,
                        reason: "required",
                        onConfirm: async (reason) => !!(await run("member", () => withdrawParticipantAction({ participantId: m.id, reason }), { success: () => `${m.name} withdrawn` }))?.ok,
                      })
                    }
                  >
                    <UserMinus />
                  </Button>
                </>
              )}
            </li>
          ))}
        </ul>
      </div>

      <div className="flex flex-wrap gap-2 rounded-lg border border-destructive/30 p-3">
        <p className="w-full text-sm text-muted-foreground">Archiving releases room seats and hides the team from the desks; all records are kept. Delete only works for a team with no check-in, coupon or room history.</p>
        <Button
          variant="outline"
          onClick={() =>
            setConfirm({
              title: `Archive ${team.name}?`,
              confirmLabel: "Archive team",
              destructive: true,
              reason: "required",
              onConfirm: async (reason) => {
                const res = await run("team", () => archiveTeamAction({ teamId: team.id, reason }), { success: () => `${team.name} archived` });
                if (res?.ok) close();
                return !!res?.ok;
              },
            })
          }
        >
          <Archive /> Archive team
        </Button>
        <Button
          variant="destructive"
          onClick={() =>
            setConfirm({
              title: `Permanently delete ${team.name}?`,
              description: "Use this only for a registration created by mistake. It is refused if the team has any operational records.",
              confirmLabel: "Delete team",
              destructive: true,
              reason: "required",
              onConfirm: async (reason) => {
                const res = await run("team", () => deleteTeamAction({ teamId: team.id, reason }), { success: () => `${team.name} deleted` });
                if (res?.ok) close();
                return !!res?.ok;
              },
            })
          }
        >
          <Trash2 /> Delete
        </Button>
      </div>

      {editing && (
        <MemberDialog
          key={editing.member?.id ?? "new"}
          title={editing.member ? `Edit ${editing.member.name}` : `Add a member to ${team.name}`}
          initial={editing.member ? { name: editing.member.name, email: editing.member.email ?? "", phone: editing.member.phone ?? "", isLeader: editing.member.isLeader } : blank}
          onClose={() => setEditing(null)}
          onSave={saveMember}
        />
      )}
      <ConfirmDialog request={confirm} onClose={() => setConfirm(null)} />
    </section>
  );
}

function TeamHistory({ team }: { team: TeamState }) {
  const [data, setData] = useState<{ key: string; rows: AuditRow[] } | null>(null);
  const [nonce, setNonce] = useState(0);
  // Refetch when anything about the team changes, or on demand.
  const key = `${team.present}|${COUPON_TYPES.map((c) => team.coupons[c]).join(",")}|${SESSION_IDS.map((s) => `${team.rooms[s]?.roomId}:${team.rooms[s]?.allocated}`).join(",")}|${team.size}|${team.name}|${nonce}`;

  useEffect(() => {
    let cancelled = false;
    void callAction(() => teamHistoryAction(team.id)).then((res) => {
      if (cancelled) return;
      if (res.ok) setData({ key, rows: res.data });
      else toast.error(res.error.message);
    });
    return () => {
      cancelled = true;
    };
  }, [team.id, key]);
  const loading = data?.key !== key;
  const rows = data?.rows ?? null;

  return (
    <section className="rounded-lg border">
      <div className="flex items-center justify-between border-b px-3 py-2">
        <h3 className="text-sm font-semibold">History</h3>
        <Button size="icon-sm" variant="ghost" aria-label="Reload history" onClick={() => setNonce((n) => n + 1)}>
          <RefreshCw className={loading ? "animate-spin" : ""} />
        </Button>
      </div>
      {rows === null ? <p className="px-4 py-6 text-center text-sm text-muted-foreground">Loading…</p> : <AuditList rows={rows} />}
    </section>
  );
}

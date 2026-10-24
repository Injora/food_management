"use client";

import { useState } from "react";
import { Archive, LoaderCircle, Plus, Trash2, Undo2 } from "lucide-react";
import { toast } from "sonner";

import { useBoard } from "@/components/board-context";
import { useTeamPanel } from "@/components/team-panel";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { callAction } from "@/lib/client-fetch";
import { formatDateTime } from "@/lib/format";
import { createTeamAction, restoreTeamAction } from "@/server/actions/teams";

type Row = { name: string; email: string; phone: string };
const emptyRow = (): Row => ({ name: "", email: "", phone: "" });

/** Walk-in registration at the desk (admin). */
export function NewTeamButton() {
  const { refresh } = useBoard();
  const { openTeam } = useTeamPanel();
  const [open, setOpen] = useState(false);
  const [teamName, setTeamName] = useState("");
  const [college, setCollege] = useState("");
  const [rows, setRows] = useState<Row[]>([emptyRow(), emptyRow()]);
  const [leader, setLeader] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reset = () => {
    setTeamName("");
    setCollege("");
    setRows([emptyRow(), emptyRow()]);
    setLeader(0);
    setError(null);
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const members = rows.map((r, i) => ({ ...r, i })).filter((r) => r.name.trim());
    const leaderIndex = members.findIndex((m) => m.i === leader);
    if (leaderIndex === -1) return setError("Choose a leader with a name.");
    setBusy(true);
    setError(null);
    const res = await callAction(() => createTeamAction({ teamName, college, members: members.map(({ i: _i, ...m }) => m), leaderIndex }));
    setBusy(false);
    if (!res.ok) return setError(res.error.message);
    toast.success(`${teamName} registered (${res.data.teamCode})`);
    await refresh();
    setOpen(false);
    reset();
    openTeam(res.data.teamId);
  };

  return (
    <>
      <Button onClick={() => setOpen(true)}>
        <Plus /> Register team
      </Button>
      <Dialog open={open} onOpenChange={(o) => !busy && setOpen(o)}>
        <DialogContent className="sm:max-w-2xl">
          <form onSubmit={submit} className="flex flex-col gap-4">
            <DialogHeader>
              <DialogTitle>Register a team at the desk</DialogTitle>
              <DialogDescription>For walk-ins missing from the registration file. Members get coupon entitlements immediately.</DialogDescription>
            </DialogHeader>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="nt-name">Team name</Label>
                <Input id="nt-name" value={teamName} onChange={(e) => setTeamName(e.target.value)} required maxLength={120} autoFocus />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="nt-college">College / company</Label>
                <Input id="nt-college" value={college} onChange={(e) => setCollege(e.target.value)} maxLength={200} />
              </div>
            </div>
            <fieldset className="flex flex-col gap-2">
              <legend className="mb-1 text-sm font-medium">Members (choose the leader)</legend>
              {rows.map((r, i) => (
                <div key={i} className="grid grid-cols-[auto_1fr_1fr_1fr_auto] items-center gap-2">
                  <input type="radio" name="leader" checked={leader === i} onChange={() => setLeader(i)} aria-label={`Member ${i + 1} is the leader`} className="size-4 accent-primary" />
                  <Input placeholder="Name" value={r.name} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} maxLength={120} aria-label={`Member ${i + 1} name`} />
                  <Input placeholder="Email" type="email" value={r.email} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, email: e.target.value } : x)))} aria-label={`Member ${i + 1} email`} />
                  <Input placeholder="Phone" value={r.phone} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, phone: e.target.value } : x)))} aria-label={`Member ${i + 1} phone`} />
                  <Button type="button" variant="ghost" size="icon-sm" aria-label={`Remove member ${i + 1}`} disabled={rows.length === 1} onClick={() => { setRows(rows.filter((_, j) => j !== i)); if (leader >= i && leader > 0) setLeader(leader - 1); }}>
                    <Trash2 />
                  </Button>
                </div>
              ))}
              {rows.length < 10 && (
                <Button type="button" variant="outline" size="sm" className="self-start" onClick={() => setRows([...rows, emptyRow()])}>
                  <Plus /> Add member
                </Button>
              )}
            </fieldset>
            {error && <p role="alert" className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setOpen(false)} disabled={busy}>
                Cancel
              </Button>
              <Button type="submit" disabled={busy || !teamName.trim() || !rows.some((r) => r.name.trim())}>
                {busy && <LoaderCircle className="animate-spin" />} Register team
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}

type ArchivedTeam = { id: string; teamName: string; teamCode: string; archivedAt: string; reason: string | null };

export function ArchivedTeams({ teams }: { teams: ArchivedTeam[] }) {
  const { refresh } = useBoard();
  const [busy, setBusy] = useState<string | null>(null);
  return (
    <section className="rounded-xl border bg-card">
      <h2 className="flex items-center gap-2 border-b px-4 py-3 text-sm font-semibold">
        <Archive className="size-4" aria-hidden /> Archived teams ({teams.length})
      </h2>
      <ul className="divide-y text-sm">
        {teams.map((t) => (
          <li key={t.id} className="flex items-center gap-3 px-4 py-2">
            <span className="min-w-0 flex-1">
              <span className="font-medium">{t.teamName}</span> <span className="font-mono text-xs text-muted-foreground">{t.teamCode}</span>
              <span className="block text-xs text-muted-foreground">
                Archived {formatDateTime(t.archivedAt)}
                {t.reason && ` — ${t.reason}`}
              </span>
            </span>
            <Button
              size="sm"
              variant="outline"
              disabled={busy !== null}
              onClick={async () => {
                setBusy(t.id);
                const res = await callAction(() => restoreTeamAction({ teamId: t.id }));
                setBusy(null);
                if (res.ok) {
                  toast.success(`${t.teamName} restored`);
                  await refresh();
                } else toast.error(res.error.message);
              }}
            >
              {busy === t.id ? <LoaderCircle className="animate-spin" /> : <Undo2 />} Restore
            </Button>
          </li>
        ))}
      </ul>
    </section>
  );
}

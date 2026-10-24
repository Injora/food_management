"use client";

import { useState } from "react";
import { KeyRound, LoaderCircle, Plus } from "lucide-react";
import { toast } from "sonner";

import { NativeSelect } from "@/components/native-select";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { callAction } from "@/lib/client-fetch";
import type { ActionResult } from "@/lib/errors";
import type { Role } from "@/lib/domain";
import { createUserAction, updateUserAction } from "@/server/actions/users";
import type { UserRow } from "@/server/services/users";

async function report<T>(promise: () => Promise<ActionResult<T>>, success: string) {
  const res = await callAction(promise);
  if (res.ok) toast.success(success);
  else toast.error(res.error.message);
  return res.ok;
}

export function UsersManager({ users, currentUserId }: { users: UserRow[]; currentUserId: string }) {
  const [busy, setBusy] = useState<string | null>(null);
  const run = async (id: string, fn: () => Promise<ActionResult<unknown>>, msg: string) => {
    setBusy(id);
    await report(fn, msg);
    setBusy(null);
  };

  return (
    <div className="flex flex-col gap-3">
      <div>
        <NewUserDialog />
      </div>
      <div className="overflow-x-auto rounded-xl border bg-card">
        <table className="w-full min-w-[40rem] text-sm">
          <thead className="bg-muted/50 text-left text-xs text-muted-foreground uppercase">
            <tr>
              <th scope="col" className="px-4 py-2 font-medium">Name</th>
              <th scope="col" className="px-4 py-2 font-medium">Role</th>
              <th scope="col" className="px-4 py-2 font-medium">Status</th>
              <th scope="col" className="px-4 py-2 text-right font-medium">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {users.map((u) => {
              const self = u.id === currentUserId;
              return (
                <tr key={u.id} className={u.active ? "" : "opacity-60"}>
                  <td className="px-4 py-2.5">
                    <p className="font-medium">
                      {u.name} {self && <span className="text-xs font-normal text-muted-foreground">(you)</span>}
                    </p>
                    <p className="text-xs text-muted-foreground">{u.email}</p>
                  </td>
                  <td className="px-4 py-2.5">
                    <NativeSelect
                      aria-label={`Role for ${u.name}`}
                      className="w-36 [&_select]:h-8"
                      value={u.role}
                      disabled={self || busy === u.id}
                      onChange={(e) => run(u.id, () => updateUserAction({ userId: u.id, role: e.target.value as Role }), `${u.name} is now ${e.target.value}`)}
                    >
                      <option value="organizer">Volunteer</option>
                      <option value="admin">Admin</option>
                    </NativeSelect>
                  </td>
                  <td className="px-4 py-2.5">{u.active ? "Active" : "Disabled"}</td>
                  <td className="px-4 py-2.5">
                    <div className="flex justify-end gap-1.5">
                      <ResetPasswordDialog user={u} />
                      {!self && (
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={busy === u.id}
                          onClick={() =>
                            run(u.id, () => updateUserAction({ userId: u.id, active: !u.active }), u.active ? `${u.name} disabled and signed out` : `${u.name} enabled`)
                          }
                        >
                          {busy === u.id && <LoaderCircle className="animate-spin" />}
                          {u.active ? "Disable" : "Enable"}
                        </Button>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function NewUserDialog() {
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  return (
    <Dialog open={open} onOpenChange={(o) => !pending && setOpen(o)}>
      <DialogTrigger render={<Button />}>
        <Plus /> Add volunteer
      </DialogTrigger>
      <DialogContent>
        <form
          className="flex flex-col gap-4"
          onSubmit={async (e) => {
            e.preventDefault();
            const f = new FormData(e.currentTarget);
            setPending(true);
            const ok = await report(
              () => createUserAction({ email: String(f.get("email")), name: String(f.get("name")), role: String(f.get("role")), password: String(f.get("password")) }),
              "Account created. Share the password with them privately.",
            );
            setPending(false);
            if (ok) setOpen(false);
          }}
        >
          <DialogHeader>
            <DialogTitle>Add volunteer</DialogTitle>
          </DialogHeader>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="u-name">Name</Label>
            <Input id="u-name" name="name" required maxLength={120} />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="u-email">Email</Label>
            <Input id="u-email" name="email" type="email" required />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="u-role">Role</Label>
            <NativeSelect id="u-role" name="role" defaultValue="organizer">
              <option value="organizer">Volunteer: check-in, coupons, rooms</option>
              <option value="admin">Admin: everything</option>
            </NativeSelect>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="u-password">Temporary password</Label>
            <Input id="u-password" name="password" type="text" required minLength={10} autoComplete="new-password" />
            <p className="text-xs text-muted-foreground">At least 10 characters.</p>
          </div>
          <DialogFooter>
            <Button type="submit" disabled={pending}>
              {pending && <LoaderCircle className="animate-spin" />} Create account
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ResetPasswordDialog({ user }: { user: UserRow }) {
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  return (
    <Dialog open={open} onOpenChange={(o) => !pending && setOpen(o)}>
      <DialogTrigger render={<Button variant="ghost" size="sm" />}>
        <KeyRound /> Password
      </DialogTrigger>
      <DialogContent>
        <form
          className="flex flex-col gap-4"
          onSubmit={async (e) => {
            e.preventDefault();
            const password = String(new FormData(e.currentTarget).get("password"));
            setPending(true);
            const ok = await report(() => updateUserAction({ userId: user.id, password }), `Password reset; ${user.name}'s sessions were signed out`);
            setPending(false);
            if (ok) setOpen(false);
          }}
        >
          <DialogHeader>
            <DialogTitle>Reset password for {user.name}</DialogTitle>
          </DialogHeader>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`pw-${user.id}`}>New password</Label>
            <Input id={`pw-${user.id}`} name="password" type="text" required minLength={10} autoComplete="new-password" />
          </div>
          <DialogFooter>
            <Button type="submit" disabled={pending}>
              {pending && <LoaderCircle className="animate-spin" />} Reset password
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

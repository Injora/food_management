"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { CircleAlert, LoaderCircle, Pencil, Plus, Trash2, Undo2, Users } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { callAction } from "@/lib/client-fetch";
import type { ActionResult } from "@/lib/errors";
import { MEAL_LABELS, type MealType } from "@/lib/meals";
import { correctCouponQuantityAction, revertIssuanceAction } from "@/server/actions/distribution";
import { correctMemberCountAction, createTeamAction, deleteTeamAction, updateTeamAction } from "@/server/actions/teams";

type TeamFields = { teamName: string; teamCode: string; leaderName: string; leaderEmail: string; memberCount: number };

/** Dialog with a form whose submit runs a server action and reports the result. */
function ActionDialog<T>({
  trigger,
  title,
  description,
  submitLabel,
  destructive,
  onSubmit,
  onSuccess,
  children,
}: {
  trigger: React.ReactElement;
  title: string;
  description?: React.ReactNode;
  submitLabel: string;
  destructive?: boolean;
  onSubmit: (form: FormData) => Promise<ActionResult<T>>;
  onSuccess: (data: T) => void;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (pending) return;
        setOpen(o);
        setError(null);
      }}
    >
      <DialogTrigger render={trigger} />
      <DialogContent className="sm:max-w-md">
        <form
          className="flex flex-col gap-4"
          onSubmit={async (e) => {
            e.preventDefault();
            setPending(true);
            setError(null);
            const result = await callAction(() => onSubmit(new FormData(e.currentTarget)));
            setPending(false);
            if (result.ok) {
              setOpen(false);
              onSuccess(result.data);
            } else {
              setError(result.error.message);
            }
          }}
        >
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            {description && <DialogDescription>{description}</DialogDescription>}
          </DialogHeader>
          {children}
          {error && (
            <p role="alert" className="flex items-start gap-2 rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">
              <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
              {error}
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" disabled={pending} onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" variant={destructive ? "destructive" : "default"} disabled={pending}>
              {pending && <LoaderCircle className="animate-spin" />}
              {submitLabel}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function Field({ id, label, hint, children }: { id: string; label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      {children}
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

function ReasonField({ placeholder }: { placeholder: string }) {
  return (
    <Field id="reason" label="Reason (required, kept in the audit log)">
      <Textarea id="reason" name="reason" required minLength={5} maxLength={500} placeholder={placeholder} />
    </Field>
  );
}

function TeamFieldset({ initial, lockMemberCount }: { initial?: TeamFields; lockMemberCount?: boolean }) {
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <div className="sm:col-span-2">
        <Field id="teamName" label="Team name">
          <Input id="teamName" name="teamName" required maxLength={120} defaultValue={initial?.teamName} />
        </Field>
      </div>
      <Field id="teamCode" label="Team code" hint={initial ? "Leave blank to keep the current code" : "Leave blank to generate one"}>
        <Input id="teamCode" name="teamCode" maxLength={40} defaultValue={initial?.teamCode} className="font-mono uppercase" />
      </Field>
      <Field
        id="memberCount"
        label="Members"
        hint={lockMemberCount ? "Locked: coupons were issued. Use Correct member count." : undefined}
      >
        <Input
          id="memberCount"
          name="memberCount"
          type="number"
          inputMode="numeric"
          min={1}
          max={1000}
          step={1}
          required
          readOnly={lockMemberCount}
          defaultValue={initial?.memberCount ?? 1}
        />
      </Field>
      <Field id="leaderName" label="Leader name">
        <Input id="leaderName" name="leaderName" maxLength={120} defaultValue={initial?.leaderName} />
      </Field>
      <Field id="leaderEmail" label="Leader email">
        <Input id="leaderEmail" name="leaderEmail" type="email" maxLength={254} defaultValue={initial?.leaderEmail} />
      </Field>
    </div>
  );
}

const readTeamFields = (form: FormData): TeamFields => ({
  teamName: String(form.get("teamName") ?? ""),
  teamCode: String(form.get("teamCode") ?? ""),
  leaderName: String(form.get("leaderName") ?? ""),
  leaderEmail: String(form.get("leaderEmail") ?? ""),
  memberCount: Number(form.get("memberCount")),
});

export function NewTeamButton() {
  const router = useRouter();
  return (
    <ActionDialog
      trigger={
        <Button>
          <Plus /> Add team
        </Button>
      }
      title="Add a team"
      description="Breakfast, lunch and dinner records are created as pending, with coupons equal to the member count."
      submitLabel="Add team"
      onSubmit={(form) => createTeamAction(readTeamFields(form))}
      onSuccess={(data) => {
        toast.success(`Team ${data.teamCode} added`);
        router.push(`/teams/${data.id}`);
      }}
    >
      <TeamFieldset />
    </ActionDialog>
  );
}

export function EditTeamButton({ teamId, initial, hasIssued }: { teamId: string; initial: TeamFields; hasIssued: boolean }) {
  return (
    <ActionDialog
      trigger={
        <Button variant="outline">
          <Pencil /> Edit details
        </Button>
      }
      title="Edit team"
      submitLabel="Save changes"
      onSubmit={(form) => updateTeamAction({ teamId, ...readTeamFields(form) })}
      onSuccess={(data) => toast.success(data.changed ? "Team updated" : "No changes to save")}
    >
      <TeamFieldset initial={initial} lockMemberCount={hasIssued} />
    </ActionDialog>
  );
}

export function CorrectMemberCountButton({ teamId, memberCount }: { teamId: string; memberCount: number }) {
  const [updatePending, setUpdatePending] = useState(true);
  return (
    <ActionDialog
      trigger={
        <Button variant="outline">
          <Users /> Correct member count
        </Button>
      }
      title="Correct member count"
      description="Admin correction. Meals already issued keep the quantity actually handed out; adjust those individually if needed."
      submitLabel="Apply correction"
      onSubmit={(form) =>
        correctMemberCountAction({
          teamId,
          memberCount: Number(form.get("memberCount")),
          reason: String(form.get("reason") ?? ""),
          updatePendingMeals: updatePending,
        })
      }
      onSuccess={() => toast.success("Member count corrected")}
    >
      <Field id="memberCount" label={`New member count (currently ${memberCount})`}>
        <Input id="memberCount" name="memberCount" type="number" inputMode="numeric" min={1} max={1000} required defaultValue={memberCount} />
      </Field>
      <label className="flex items-center gap-2 text-sm">
        <Checkbox checked={updatePending} onCheckedChange={(v) => setUpdatePending(v === true)} />
        Also update coupon quantity for meals that are still pending
      </label>
      <ReasonField placeholder="e.g. Two members registered late at the help desk" />
    </ActionDialog>
  );
}

export function RevertIssuanceButton({ teamId, meal }: { teamId: string; meal: MealType }) {
  return (
    <ActionDialog
      trigger={
        <Button variant="outline" size="sm">
          <Undo2 /> Revert
        </Button>
      }
      title={`Revert ${MEAL_LABELS[meal].toLowerCase()} issuance?`}
      description="The meal goes back to pending. The original issuance stays in the audit history."
      submitLabel="Revert to pending"
      destructive
      onSubmit={(form) => revertIssuanceAction({ teamId, meal, reason: String(form.get("reason") ?? "") })}
      onSuccess={() => toast.success(`${MEAL_LABELS[meal]} reverted to pending`)}
    >
      <ReasonField placeholder="e.g. Issued to the wrong team at the counter" />
    </ActionDialog>
  );
}

export function AdjustQuantityButton({ teamId, meal, quantity }: { teamId: string; meal: MealType; quantity: number }) {
  return (
    <ActionDialog
      trigger={
        <Button variant="ghost" size="sm">
          <Pencil /> Quantity
        </Button>
      }
      title={`Adjust ${MEAL_LABELS[meal].toLowerCase()} coupon quantity`}
      submitLabel="Save quantity"
      onSubmit={(form) =>
        correctCouponQuantityAction({ teamId, meal, quantity: Number(form.get("quantity")), reason: String(form.get("reason") ?? "") })
      }
      onSuccess={(d) => toast.success(`${MEAL_LABELS[meal]} quantity set to ${d.quantity}`)}
    >
      <Field id="quantity" label={`Coupons (currently ${quantity})`}>
        <Input id="quantity" name="quantity" type="number" inputMode="numeric" min={1} max={1000} required defaultValue={quantity} />
      </Field>
      <ReasonField placeholder="e.g. One member is a mentor and eats separately" />
    </ActionDialog>
  );
}

export function DeleteTeamButton({ teamId, teamName }: { teamId: string; teamName: string }) {
  const router = useRouter();
  return (
    <ActionDialog
      trigger={
        <Button variant="ghost" className="text-destructive">
          <Trash2 /> Delete team
        </Button>
      }
      title={`Delete ${teamName}?`}
      description="Only possible while no meal has been issued. The deletion is recorded in the audit log."
      submitLabel="Delete team"
      destructive
      onSubmit={(form) => deleteTeamAction({ teamId, reason: String(form.get("reason") ?? "") })}
      onSuccess={() => {
        toast.success(`${teamName} deleted`);
        router.replace("/teams");
      }}
    >
      <ReasonField placeholder="e.g. Duplicate registration of Code Pirates" />
    </ActionDialog>
  );
}

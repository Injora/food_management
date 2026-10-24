"use client";

import { useState } from "react";
import { LoaderCircle } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

export type ConfirmRequest = {
  title: string;
  description?: React.ReactNode;
  confirmLabel: string;
  destructive?: boolean;
  /** "required" enforces at least 5 characters, as the server does. */
  reason?: "optional" | "required";
  /** Resolve true to close the dialog. */
  onConfirm: (reason: string) => Promise<boolean>;
};

/** Confirmation step for bulk and corrective actions. Enter confirms. */
export function ConfirmDialog({ request, onClose }: { request: ConfirmRequest | null; onClose: () => void }) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const needsReason = request?.reason === "required";
  const valid = !needsReason || reason.trim().length >= 5;

  const confirm = async () => {
    if (!request || busy || !valid) return;
    setBusy(true);
    try {
      if (await request.onConfirm(reason.trim())) {
        setReason("");
        onClose();
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={request !== null}
      onOpenChange={(open) => {
        if (!open && !busy) {
          setReason("");
          onClose();
        }
      }}
    >
      <DialogContent className="sm:max-w-md">
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            void confirm();
          }}
        >
          <DialogHeader>
            <DialogTitle>{request?.title}</DialogTitle>
            {request?.description && <DialogDescription render={<div />}>{request.description}</DialogDescription>}
          </DialogHeader>
          {request?.reason && (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="confirm-reason">Reason{needsReason ? "" : " (optional)"}</Label>
              <Textarea id="confirm-reason" value={reason} onChange={(e) => setReason(e.target.value)} rows={2} maxLength={500} autoFocus />
            </div>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={busy}>
              Cancel
            </Button>
            <Button type="submit" variant={request?.destructive ? "destructive" : "default"} disabled={busy || !valid} autoFocus={!request?.reason}>
              {busy && <LoaderCircle className="animate-spin" />}
              {request?.confirmLabel}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

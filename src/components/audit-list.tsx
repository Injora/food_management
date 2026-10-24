import { formatDateTime } from "@/lib/format";
import { COUPON_LABELS, SESSION_LABELS } from "@/lib/domain";
import type { AuditRow } from "@/server/services/audit";

export const AUDIT_LABELS: Record<AuditRow["action"], string> = {
  csv_import: "Registration import",
  team_create: "Team registered",
  team_update: "Team edited",
  team_delete: "Team deleted",
  team_archive: "Team archived",
  member_count_correction: "Member count corrected",
  coupon_issue: "Coupons issued",
  coupon_reversal: "Coupon reverted",
  coupon_quantity_correction: "Coupon quantity corrected",
  user_create: "Account added",
  user_update: "Account updated",
  participant_create: "Member added",
  participant_update: "Member edited",
  participant_withdraw: "Member withdrawn",
  check_in: "Checked in",
  check_in_undo: "Check-in undone",
  room_assign: "Room allocated",
  room_move: "Moved room",
  room_release: "Room seats released",
  room_update: "Room settings changed",
  room_create: "Room added",
  session_update: "Session settings changed",
  mlh_import: "MLH list uploaded",
};

const show = (v: unknown) => (v === null || v === undefined || v === "" ? "—" : String(v));
const people = (d: Record<string, unknown> | null) => {
  const list = d?.participants as { name: string }[] | undefined;
  return list && list.length > 0 ? list.map((p) => p.name).join(", ") : null;
};

function describe(row: AuditRow): string | null {
  const a = row.after ?? {};
  const b = row.before ?? {};
  switch (row.action) {
    case "csv_import": {
      const s = (row.details?.summary ?? {}) as Record<string, number>;
      return `${show(row.details?.fileName)}: ${s.create ?? 0} teams created, ${s.update ?? 0} updated, ${s.participantsToCreate ?? 0} participants added`;
    }
    case "check_in":
    case "check_in_undo":
      return `${people(row.details) ?? ""} · now ${show(a.present)}/${show(a.size)} present`;
    case "coupon_issue":
      return `${people(row.details) ?? ""} · team ${show(a.issued)}/${show(a.entitled)}`;
    case "coupon_reversal":
      return people(row.details);
    case "room_assign":
      return `${people(row.details) ?? ""} → Room ${show(a.room)} (room now ${show(a.occupancy)}/${show(a.nominalCapacity)})`;
    case "room_move":
      return `Room ${show(b.room)} → Room ${show(a.room)} · ${show(a.teamAllocated)} members`;
    case "room_release":
      return `Room ${show(b.room)} · ${show(b.teamAllocated)} → ${show(a.teamAllocated)} seated`;
    case "team_update":
      if (row.details?.importId) {
        const changes = [...((row.details.changes as string[]) ?? []), ...((row.details.memberChanges as { name: string; detail: string }[]) ?? []).map((c) => `${c.name}: ${c.detail}`)];
        return changes.join(" · ") || null;
      }
      break;
    case "participant_withdraw":
    case "participant_update":
      if (row.details?.participant && Object.keys(a).length === 0) return show(row.details.participant);
      break;
  }
  const keys = [...new Set([...Object.keys(b), ...Object.keys(a)])];
  if (keys.length === 0) return null;
  return keys
    .map((k) => {
      if (k === "password") return "password reset";
      if (row.action === "team_delete") return `${k} ${show(b[k])}`;
      return `${k}: ${show(b[k])} → ${show(a[k])}`;
    })
    .join(" · ");
}

export function AuditList({ rows, showTeam = false, onTeamClick }: { rows: AuditRow[]; showTeam?: boolean; onTeamClick?: (teamId: string) => void }) {
  if (rows.length === 0) return <p className="px-4 py-8 text-center text-sm text-muted-foreground">No activity recorded yet.</p>;
  return (
    <ol className="divide-y">
      {rows.map((r) => {
        const summary = describe(r);
        return (
          <li key={r.id} className="grid gap-1 px-4 py-2.5 text-sm sm:grid-cols-[8.5rem_minmax(0,1fr)] sm:gap-4">
            <time dateTime={r.createdAt} className="tabular text-xs text-muted-foreground sm:pt-0.5">
              {formatDateTime(r.createdAt)}
            </time>
            <div className="min-w-0">
              <p className="font-medium">
                {AUDIT_LABELS[r.action]}
                {r.couponType && <span className="text-muted-foreground"> · {COUPON_LABELS[r.couponType]}</span>}
                {r.sessionId && <span className="text-muted-foreground"> · {SESSION_LABELS[r.sessionId]}</span>}
                {showTeam && r.teamLabel && (
                  <>
                    {" · "}
                    {r.teamId && onTeamClick ? (
                      <button type="button" className="font-medium hover:underline" onClick={() => onTeamClick(r.teamId!)}>
                        {r.teamLabel}
                      </button>
                    ) : (
                      r.teamLabel
                    )}
                  </>
                )}
              </p>
              {summary && <p className="break-words text-muted-foreground">{summary}</p>}
              {r.reason && <p className="mt-0.5 text-muted-foreground italic">&ldquo;{r.reason}&rdquo;</p>}
              <p className="text-xs text-muted-foreground">by {r.actorEmail ?? "system"}</p>
            </div>
          </li>
        );
      })}
    </ol>
  );
}

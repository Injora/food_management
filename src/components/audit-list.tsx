import Link from "next/link";

import { formatDateTime } from "@/lib/format";
import { MEAL_LABELS } from "@/lib/meals";
import type { AuditRow } from "@/server/services/audit";

export const AUDIT_LABELS: Record<AuditRow["action"], string> = {
  csv_import: "CSV import",
  team_create: "Team created",
  team_update: "Team edited",
  team_delete: "Team deleted",
  member_count_correction: "Member count corrected",
  coupon_issue: "Coupons issued",
  coupon_reversal: "Issuance reverted",
  coupon_quantity_correction: "Coupon quantity corrected",
  user_create: "Organizer added",
  user_update: "Organizer updated",
};

const FIELD_LABELS: Record<string, string> = {
  teamName: "name",
  teamCode: "code",
  leaderName: "leader",
  leaderEmail: "leader email",
  memberCount: "members",
  couponQuantity: "coupons",
  status: "status",
  role: "role",
  active: "active",
  name: "name",
  password: "password",
};

const show = (v: unknown) => (v === null || v === undefined || v === "" ? "—" : String(v));

function describe(row: AuditRow): string | null {
  if (row.action === "csv_import" && row.details) {
    const s = row.details.summary as Record<string, number> | undefined;
    return `${String(row.details.fileName ?? "file")}: ${s?.create ?? 0} created, ${s?.update ?? 0} updated, ${(s?.invalidRows ?? 0) + (s?.duplicates ?? 0)} rejected`;
  }
  if (row.action === "coupon_issue") return `${show(row.after?.couponQuantity)} coupons`;
  const keys = [...new Set([...Object.keys(row.before ?? {}), ...Object.keys(row.after ?? {})])].filter((k) => k !== "issuedAt");
  if (keys.length === 0) return null;
  return keys
    .map((k) => {
      const from = row.before?.[k];
      const to = row.after?.[k];
      if (k === "password") return "password reset";
      if (row.action === "team_delete") return `${FIELD_LABELS[k] ?? k} ${show(from)}`;
      return `${FIELD_LABELS[k] ?? k}: ${show(from)} → ${show(to)}`;
    })
    .join(" · ");
}

export function AuditList({ rows, showTeam = false }: { rows: AuditRow[]; showTeam?: boolean }) {
  if (rows.length === 0) return <p className="px-4 py-8 text-center text-sm text-muted-foreground">No activity recorded yet.</p>;
  return (
    <ol className="divide-y">
      {rows.map((r) => {
        const summary = describe(r);
        return (
          <li key={r.id} className="grid gap-1 px-4 py-3 text-sm sm:grid-cols-[10rem_minmax(0,1fr)] sm:gap-4">
            <time dateTime={r.createdAt} className="tabular text-xs text-muted-foreground sm:pt-0.5">
              {formatDateTime(r.createdAt)}
            </time>
            <div className="min-w-0">
              <p className="font-medium">
                {AUDIT_LABELS[r.action]}
                {r.mealType && <span className="text-muted-foreground"> · {MEAL_LABELS[r.mealType]}</span>}
                {showTeam && r.teamLabel && (
                  <>
                    {" · "}
                    {r.teamId ? (
                      <Link href={`/teams/${r.teamId}`} className="hover:underline">
                        {r.teamLabel}
                      </Link>
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

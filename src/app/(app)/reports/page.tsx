import type { Metadata } from "next";
import { Download } from "lucide-react";

import { AuditList } from "@/components/audit-list";
import { Forbidden } from "@/components/forbidden";
import { PageHeader } from "@/components/page-header";
import { getDb } from "@/db";
import { effectiveMax, isLimited, nominalRemaining } from "@/lib/capacity";
import { COUPON_LABELS, COUPON_TYPES, SESSION_LABELS } from "@/lib/domain";
import { summarize } from "@/lib/summary";
import { requireActor } from "@/server/auth/current";
import { can } from "@/server/auth/permissions";
import { listAudit } from "@/server/services/audit";
import { loadBoard } from "@/server/services/board";

export const metadata: Metadata = { title: "Reports" };

const GROUPS: { title: string; links: [string, string][] }[] = [
  {
    title: "Registrations & attendance",
    links: [
      ["Full registrations (every participant)", "/api/export/registrations"],
      ["Present participants", "/api/export/attendance?status=present"],
      ["Absent participants", "/api/export/attendance?status=absent"],
    ],
  },
  {
    title: "Team check-ins",
    links: [
      ["All teams with attendance", "/api/export/team-checkins"],
      ["Complete teams", "/api/export/team-checkins?status=full"],
      ["Partially checked-in teams", "/api/export/team-checkins?status=partial"],
      ["Teams not checked in", "/api/export/team-checkins?status=none"],
    ],
  },
  {
    title: "Food coupons",
    links: [
      ["All coupon transactions", "/api/export/coupons"],
      ...COUPON_TYPES.map((c): [string, string] => [`${COUPON_LABELS[c]} coupons issued`, `/api/export/coupons?meal=${c}`]),
      ["Issued vs pending per team", "/api/export/coupon-summary"],
    ],
  },
  {
    title: "Rooms",
    links: [
      ["Open-source talk room assignments", "/api/export/allocations?session=talks"],
      ["Hackathon room assignments", "/api/export/allocations?session=hackathon"],
      ["Room occupancy and remaining capacity", "/api/export/occupancy"],
    ],
  },
  { title: "Audit", links: [["Full audit log", "/api/export/audit"]] },
];

export default async function ReportsPage() {
  const actor = await requireActor();
  if (!can(actor, "reports:view")) return <Forbidden what="reports" />;
  const db = await getDb();
  const [board, audit] = await Promise.all([loadBoard(db, actor), listAudit(db, actor, { limit: 100 })]);
  const s = summarize(board);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Reports" description="CSV exports are generated from the database at download time." />

      <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {GROUPS.map((g) => (
          <div key={g.title} className="rounded-xl border bg-card">
            <h2 className="border-b px-4 py-3 text-sm font-semibold">{g.title}</h2>
            <ul className="divide-y">
              {g.links.map(([label, href]) => (
                <li key={href}>
                  <a href={href} download className="flex items-center gap-2 px-4 py-2.5 text-sm hover:bg-muted/50">
                    <Download className="size-4 text-muted-foreground" aria-hidden /> {label}
                  </a>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </section>

      <section className="grid gap-4 lg:grid-cols-2">
        <div className="rounded-xl border bg-card">
          <h2 className="border-b px-4 py-3 text-sm font-semibold">Attendance & coupons</h2>
          <table className="tabular w-full text-sm">
            <tbody className="divide-y">
              <tr>
                <td className="px-4 py-2">Participants present</td>
                <td className="px-4 py-2 text-right font-semibold">
                  {s.present} / {s.participants}
                </td>
              </tr>
              <tr>
                <td className="px-4 py-2">Teams complete / partial / not in</td>
                <td className="px-4 py-2 text-right font-semibold">
                  {s.teamsFull} / {s.teamsPartial} / {s.teamsNone}
                </td>
              </tr>
              {COUPON_TYPES.map((c) => (
                <tr key={c}>
                  <td className="px-4 py-2">{COUPON_LABELS[c]} coupons issued</td>
                  <td className="px-4 py-2 text-right font-semibold">
                    {s.coupons[c].issued} / {s.coupons[c].entitled}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="rounded-xl border bg-card">
          <h2 className="border-b px-4 py-3 text-sm font-semibold">Room occupancy</h2>
          <table className="tabular w-full text-sm">
            <thead className="text-muted-foreground">
              <tr>
                <th className="px-4 py-2 text-left font-medium">Room</th>
                <th className="px-4 py-2 text-right font-medium">Occupancy</th>
                <th className="px-4 py-2 text-right font-medium">Slots left</th>
                <th className="px-4 py-2 text-right font-medium">Max</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {board.rooms.map((r) =>
                isLimited(r) ? (
                  <tr key={r.id} className={r.occupancy > r.nominalCapacity ? "text-destructive" : undefined}>
                    <td className="px-4 py-1.5">
                      {SESSION_LABELS[r.sessionId]} · {r.roomNumber}
                    </td>
                    <td className="px-4 py-1.5 text-right">
                      {r.occupancy}/{r.nominalCapacity}
                    </td>
                    <td className="px-4 py-1.5 text-right">{nominalRemaining(r)}</td>
                    <td className="px-4 py-1.5 text-right">{effectiveMax(r)}</td>
                  </tr>
                ) : (
                  <tr key={r.id}>
                    <td className="px-4 py-1.5">
                      {SESSION_LABELS[r.sessionId]} · {r.roomNumber}
                    </td>
                    <td className="px-4 py-1.5 text-right">
                      {r.occupancy} ({r.teams.length} teams)
                    </td>
                    <td className="px-4 py-1.5 text-right text-muted-foreground" colSpan={2}>
                      no limit
                    </td>
                  </tr>
                ),
              )}
            </tbody>
          </table>
        </div>
      </section>

      <section className="rounded-xl border bg-card">
        <h2 className="border-b px-4 py-3 text-sm font-semibold">Audit log (latest 100 of {audit.total})</h2>
        <AuditList rows={audit.rows} showTeam />
      </section>
    </div>
  );
}

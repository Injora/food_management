import type { Metadata } from "next";
import { Download } from "lucide-react";

import { AuditList } from "@/components/audit-list";
import { Forbidden } from "@/components/forbidden";
import { MEAL_ICONS } from "@/components/meal-icon";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { getDb } from "@/db";
import { formatNumber, formatPercent } from "@/lib/format";
import { MEAL_LABELS, MEAL_TYPES } from "@/lib/meals";
import { requireActor } from "@/server/auth/current";
import { can } from "@/server/auth/permissions";
import { listAudit } from "@/server/services/audit";
import { getDashboardStats } from "@/server/services/stats";
import { listTeams } from "@/server/services/teams";
import { CollectionMatrix } from "./collection-matrix";
import { PendingExport } from "./pending-export";

export const metadata: Metadata = { title: "Reports" };

function ExportLink({ href, children }: { href: string; children: React.ReactNode }) {
  // Plain links: the route handler checks the session and streams the CSV.
  return (
    <Button variant="outline" size="sm" nativeButton={false} render={<a href={href} download />}>
      <Download /> {children}
    </Button>
  );
}

export default async function ReportsPage() {
  const actor = await requireActor();
  if (!can(actor, "reports:view")) return <Forbidden what="reports" />;
  const db = getDb();
  const [stats, teams, audit] = await Promise.all([getDashboardStats(db, actor), listTeams(db, actor), listAudit(db, actor, { limit: 50 })]);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Reports"
        description="Figures and exports are read from the database when you open or download them."
        actions={<ExportLink href="/api/export/teams">All teams</ExportLink>}
      />

      <section className="overflow-x-auto rounded-xl border bg-card">
        <h2 className="border-b px-4 py-3 text-sm font-semibold">Distribution by meal</h2>
        <table className="w-full min-w-[52rem] text-sm">
          <thead className="bg-muted/50 text-xs text-muted-foreground uppercase">
            <tr className="text-right">
              <th scope="col" className="px-4 py-2 text-left font-medium">Meal</th>
              <th scope="col" colSpan={3} className="border-l px-4 py-1 text-center font-medium tracking-wide">Teams</th>
              <th scope="col" colSpan={3} className="border-l px-4 py-1 text-center font-medium tracking-wide">Coupons</th>
              <th scope="col" className="border-l px-4 py-2 font-medium"><span className="sr-only">Exports</span></th>
            </tr>
            <tr className="text-right text-[11px]">
              <th />
              <th className="border-l px-4 py-1 font-medium">Eligible</th>
              <th className="px-4 py-1 font-medium">Collected</th>
              <th className="px-4 py-1 font-medium">Pending</th>
              <th className="border-l px-4 py-1 font-medium">Expected</th>
              <th className="px-4 py-1 font-medium">Issued</th>
              <th className="px-4 py-1 font-medium">Remaining</th>
              <th className="border-l" />
            </tr>
          </thead>
          <tbody className="tabular divide-y text-right">
            {stats.meals.map((m) => {
              const Icon = MEAL_ICONS[m.meal];
              return (
                <tr key={m.meal}>
                  <th scope="row" className="px-4 py-3 text-left font-medium">
                    <span className="flex items-center gap-2">
                      <Icon className="size-4 text-muted-foreground" aria-hidden /> {MEAL_LABELS[m.meal]}
                      <span className="text-xs font-normal text-muted-foreground">
                        {formatPercent(m.eligibleTeams ? m.issuedTeams / m.eligibleTeams : 0)}
                      </span>
                    </span>
                  </th>
                  <td className="border-l px-4 py-3">{formatNumber(m.eligibleTeams)}</td>
                  <td className="px-4 py-3 text-success-foreground">{formatNumber(m.issuedTeams)}</td>
                  <td className="px-4 py-3 text-warning-foreground">{formatNumber(m.pendingTeams)}</td>
                  <td className="border-l px-4 py-3">{formatNumber(m.couponsExpected)}</td>
                  <td className="px-4 py-3 text-success-foreground">{formatNumber(m.couponsIssued)}</td>
                  <td className="px-4 py-3 font-semibold text-warning-foreground">{formatNumber(m.couponsRemaining)}</td>
                  <td className="border-l px-4 py-2">
                    <div className="flex justify-end gap-1.5">
                      <ExportLink href={`/api/export/meal?meal=${m.meal}`}>Issuance</ExportLink>
                      <ExportLink href={`/api/export/pending?meal=${m.meal}`}>Pending</ExportLink>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>

      <section className="grid gap-3 rounded-xl border bg-card p-4 sm:grid-cols-2 lg:grid-cols-4">
        <h2 className="text-sm font-semibold sm:col-span-2 lg:col-span-4">Exports (CSV)</h2>
        <ExportLink href="/api/export/teams">All teams &amp; member counts</ExportLink>
        {MEAL_TYPES.map((m) => (
          <ExportLink key={m} href={`/api/export/meal?meal=${m}`}>
            {MEAL_LABELS[m]} issuance
          </ExportLink>
        ))}
        <PendingExport />
        <ExportLink href="/api/export/audit">Audit history</ExportLink>
      </section>

      <section className="rounded-xl border bg-card">
        <h2 className="border-b px-4 py-3 text-sm font-semibold">Team collection history</h2>
        <CollectionMatrix teams={teams} />
      </section>

      <section className="rounded-xl border bg-card">
        <div className="flex items-center justify-between gap-2 border-b px-4 py-3">
          <h2 className="text-sm font-semibold">
            Audit log <span className="font-normal text-muted-foreground">· latest {audit.rows.length} of {formatNumber(audit.total)}</span>
          </h2>
          <ExportLink href="/api/export/audit">Full log</ExportLink>
        </div>
        <AuditList rows={audit.rows} showTeam />
      </section>
    </div>
  );
}

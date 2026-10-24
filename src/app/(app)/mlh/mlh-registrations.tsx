"use client";

import { useMemo, useState } from "react";
import { ClipboardList, Search, X } from "lucide-react";

import { EmptyState } from "@/components/empty-state";
import { NativeSelect } from "@/components/native-select";
import { Pill, type Tone } from "@/components/ops-badges";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { MLH_CHECKED_IN } from "@/lib/mlh";
import type { MlhList } from "@/server/services/mlh";

function statusTone(status: string): Tone {
  if (status === MLH_CHECKED_IN) return "success";
  if (status === "canceled" || status === "rejected") return "danger";
  return "neutral";
}

export function MlhRegistrations({ list }: { list: MlhList }) {
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("all");

  const statuses = useMemo(() => {
    const counts = new Map<string, number>();
    for (const r of list.rows) counts.set(r.status, (counts.get(r.status) ?? 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1]);
  }, [list.rows]);

  const needle = q.trim().toLowerCase();
  const rows = list.rows.filter(
    (r) => (status === "all" || r.status === status) && (!needle || r.fullName.toLowerCase().includes(needle) || r.teamName.toLowerCase().includes(needle)),
  );
  const filtered = needle || status !== "all";

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="MLH registrations"
        description={
          list.importedAt
            ? `${list.rows.length} candidates registered on MLH · ${statuses.map(([s, n]) => `${n} ${s}`).join(" · ")}`
            : "Candidates registered on the MLH portal."
        }
      />

      {list.rows.length === 0 ? (
        <EmptyState icon={ClipboardList} title="No MLH list yet">
          The MLH registration export hasn&apos;t been loaded.
        </EmptyState>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative min-w-56 flex-1">
              <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
              <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name or team" className="h-10 pl-9" aria-label="Search MLH registrations" />
            </div>
            <NativeSelect value={status} onChange={(e) => setStatus(e.target.value)} aria-label="MLH status" className="w-48">
              <option value="all">Any status</option>
              {statuses.map(([s, n]) => (
                <option key={s} value={s}>
                  {s} ({n})
                </option>
              ))}
            </NativeSelect>
            {filtered && (
              <Button
                variant="ghost"
                onClick={() => {
                  setQ("");
                  setStatus("all");
                }}
              >
                <X /> Clear
              </Button>
            )}
          </div>

          {rows.length === 0 ? (
            <EmptyState icon={ClipboardList} title="No candidates match">
              Try another search or clear the filters.
            </EmptyState>
          ) : (
            <div className="overflow-x-auto rounded-xl border bg-card">
              <table className="w-full text-sm">
                <thead className="border-b bg-muted/40 text-muted-foreground">
                  <tr>
                    <th className="w-12 px-3 py-2 text-right font-medium">#</th>
                    <th className="px-3 py-2 text-left font-medium">Name</th>
                    <th className="px-3 py-2 text-left font-medium">Team</th>
                    <th className="px-3 py-2 text-left font-medium">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {rows.map((r, i) => (
                    <tr key={r.id} className="hover:bg-muted/30">
                      <td className="tabular px-3 py-2 text-right text-muted-foreground">{i + 1}</td>
                      <td className="max-w-64 truncate px-3 py-2 font-medium">{r.fullName}</td>
                      <td className="max-w-64 truncate px-3 py-2">{r.teamName || <span className="text-muted-foreground">—</span>}</td>
                      <td className="px-3 py-2">
                        <Pill t={statusTone(r.status)}>{r.status}</Pill>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="border-t px-3 py-2 text-sm text-muted-foreground">
                {rows.length} candidate{rows.length === 1 ? "" : "s"}
                {filtered && ` of ${list.rows.length}`}
              </p>
            </div>
          )}
        </>
      )}
    </div>
  );
}

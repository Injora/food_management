"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { CircleAlert, CircleCheckBig, Download, FileUp, Info, LoaderCircle, Minus, Plus, RotateCcw, ShieldCheck, TriangleAlert } from "lucide-react";
import { toast } from "sonner";
import { cn } from "cn";

import { useBoard } from "@/components/board-context";
import { NativeSelect } from "@/components/native-select";
import { Pill } from "@/components/ops-badges";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { callAction } from "@/lib/client-fetch";
import { toCsv } from "@/lib/csv";
import { readRegistrationFile, type RawSheet } from "@/lib/registration-file";
import {
  detectMapping,
  emptySlot,
  mappingBaseSchema,
  mappingSchema,
  prepareTable,
  type ImportIssue,
  type Mapping,
  type PreparedTable,
  type Slot,
} from "@/lib/registration-import";
import { analyzeImportAction, commitImportAction } from "@/server/actions/import";
import type { AnalyzedTeam, ImportAnalysis, ImportMode, ImportReport, ImportRequest, TeamAction } from "@/server/services/import";

type Loaded = { fileName: string; sheets: RawSheet[]; sheetIndex: number; headerRow: number | null; mapping: Mapping };

function setup(fileName: string, sheets: RawSheet[], sheetIndex: number, headerRow?: number | null): Loaded {
  const table = prepareTable(sheets[sheetIndex].rows, headerRow === undefined ? {} : { headerRow });
  return { fileName, sheets, sheetIndex, headerRow: table.headerRow, mapping: mappingBaseSchema.parse(detectMapping(table)) };
}

const ACTION_LABEL: Record<TeamAction, string> = {
  create: "New",
  update: "Update",
  unchanged: "Unchanged",
  skip_existing: "Exists (differs)",
  blocked: "Blocked",
  deselected: "Skipped by you",
};
const ACTION_TONE: Record<TeamAction, "success" | "warning" | "danger" | "neutral"> = {
  create: "success",
  update: "warning",
  unchanged: "neutral",
  skip_existing: "neutral",
  blocked: "danger",
  deselected: "neutral",
};

function issuesCsv(issues: ImportIssue[], teams: AnalyzedTeam[]) {
  return toCsv([
    ["severity", "rows", "team", "message"],
    ...issues.map((i) => [i.severity, i.rowNumbers.join(" "), i.team, i.message]),
    ...teams.filter((t) => t.action === "blocked").map((t) => ["error", t.rowNumbers.join(" "), t.teamName, t.blockReason]),
  ]);
}

function download(name: string, text: string) {
  const url = URL.createObjectURL(new Blob(["﻿" + text], { type: "text/csv;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

export function ImportWizard() {
  const { refresh } = useBoard();
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [mode, setMode] = useState<ImportMode>("add_only");
  const [analysis, setAnalysis] = useState<ImportAnalysis | null>(null);
  const [skip, setSkip] = useState<Set<string>>(new Set());
  const [report, setReport] = useState<ImportReport | null>(null);
  const [busy, setBusy] = useState<"read" | "analyze" | "commit" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const table: PreparedTable | null = useMemo(
    () => (loaded ? prepareTable(loaded.sheets[loaded.sheetIndex].rows, { headerRow: loaded.headerRow }) : null),
    [loaded],
  );

  const reset = () => {
    setLoaded(null);
    setAnalysis(null);
    setReport(null);
    setSkip(new Set());
    setError(null);
  };

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    reset();
    setBusy("read");
    try {
      const sheets = await readRegistrationFile(file.name, new Uint8Array(await file.arrayBuffer()));
      setLoaded(setup(file.name, sheets, 0));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not read the file.");
    } finally {
      setBusy(null);
    }
  };

  const request = (skipKeys: string[] = [...skip]): ImportRequest | null =>
    loaded && {
      fileName: loaded.fileName,
      sheetName: loaded.sheets[loaded.sheetIndex].name,
      headerRow: loaded.headerRow,
      raw: loaded.sheets[loaded.sheetIndex].rows,
      mapping: loaded.mapping,
      mode,
      skipKeys,
    };

  const analyze = async () => {
    const req = request([]);
    if (!req) return;
    const check = mappingSchema.safeParse(req.mapping);
    if (!check.success) return setError(check.error.issues[0]?.message ?? "Complete the column mapping.");
    setBusy("analyze");
    setError(null);
    const res = await callAction(() => analyzeImportAction(req));
    setBusy(null);
    if (!res.ok) return setError(res.error.message);
    setAnalysis(res.data);
    setSkip(new Set());
  };

  const commit = async () => {
    const req = request();
    if (!req) return;
    setBusy("commit");
    setError(null);
    const res = await callAction(() => commitImportAction(req));
    setBusy(null);
    if (!res.ok) return setError(res.error.message);
    setReport(res.data);
    toast.success(`Imported: ${res.data.summary.create} new teams, ${res.data.summary.update} updated`);
    await refresh();
  };

  const patchMapping = (patch: Partial<Mapping>) => {
    if (!loaded) return;
    setLoaded({ ...loaded, mapping: { ...loaded.mapping, ...patch } });
    setAnalysis(null);
  };

  if (report) return <ImportDone report={report} onAgain={reset} />;

  return (
    <div className="flex flex-col gap-5">
      <section className="rounded-xl border bg-card p-4">
        <h2 className="mb-3 font-semibold">1. Choose the registration file</h2>
        <label
          className={cn(
            "flex cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed px-6 py-8 text-center hover:bg-muted/40",
            busy === "read" && "opacity-60",
          )}
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            void onFile(e.dataTransfer.files[0]);
          }}
        >
          {busy === "read" ? <LoaderCircle className="size-7 animate-spin" /> : <FileUp className="size-7 text-muted-foreground" aria-hidden />}
          <span className="font-medium">{loaded ? loaded.fileName : "Drop a .csv or .xlsx file here, or click to choose"}</span>
          <span className="text-xs text-muted-foreground">One row per team (leader + member columns) or one row per participant. Header row optional.</span>
          <input type="file" accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" className="sr-only" onChange={(e) => void onFile(e.target.files?.[0])} />
        </label>
        {error && (
          <p role="alert" className="mt-3 flex items-center gap-2 rounded-lg bg-destructive/10 px-3 py-2 text-sm font-medium text-destructive">
            <CircleAlert className="size-4" /> {error}
          </p>
        )}
      </section>

      {loaded && table && (
        <section className="flex flex-col gap-4 rounded-xl border bg-card p-4">
          <div className="flex flex-wrap items-end gap-3">
            <h2 className="mr-auto font-semibold">2. Check the layout and columns</h2>
            {loaded.sheets.length > 1 && (
              <div className="flex flex-col gap-1">
                <Label>Sheet</Label>
                <NativeSelect value={loaded.sheetIndex} onChange={(e) => { setLoaded(setup(loaded.fileName, loaded.sheets, Number(e.target.value))); setAnalysis(null); }} className="w-48">
                  {loaded.sheets.map((s, i) => (
                    <option key={i} value={i}>
                      {s.name}
                    </option>
                  ))}
                </NativeSelect>
              </div>
            )}
            <div className="flex flex-col gap-1">
              <Label>Header row</Label>
              <NativeSelect
                value={loaded.headerRow === null ? "none" : String(loaded.headerRow)}
                onChange={(e) => {
                  setLoaded(setup(loaded.fileName, loaded.sheets, loaded.sheetIndex, e.target.value === "none" ? null : Number(e.target.value)));
                  setAnalysis(null);
                }}
                className="w-56"
              >
                <option value="none">No header row (infer columns)</option>
                {loaded.sheets[loaded.sheetIndex].rows.slice(0, 10).map((_, i) => (
                  <option key={i} value={i}>
                    Row {i + 1} is the header
                  </option>
                ))}
              </NativeSelect>
            </div>
            <div className="flex flex-col gap-1">
              <Label>Layout</Label>
              <NativeSelect value={loaded.mapping.layout} onChange={(e) => patchMapping({ layout: e.target.value as Mapping["layout"] })} className="w-64">
                <option value="team_row">One row per team (member columns)</option>
                <option value="participant_row">One row per participant</option>
              </NativeSelect>
            </div>
          </div>
          {table.skippedRows.length > 0 && (
            <p className="text-sm text-muted-foreground">
              Skipping {table.skippedRows.length} line{table.skippedRows.length === 1 ? "" : "s"} above the data (row {table.skippedRows.join(", ")}) — titles or notes, not registrations.
            </p>
          )}
          <Preview table={table} />
          <MappingForm table={table} mapping={loaded.mapping} onChange={patchMapping} />
          <div className="flex flex-wrap items-end gap-3 border-t pt-4">
            <div className="flex flex-col gap-1">
              <Label>Existing teams</Label>
              <NativeSelect value={mode} onChange={(e) => { setMode(e.target.value as ImportMode); setAnalysis(null); }} className="w-80">
                <option value="add_only">Add new teams only (leave existing teams as they are)</option>
                <option value="update_existing">Add new teams and update existing registrations</option>
              </NativeSelect>
            </div>
            <Button size="lg" className="h-10 px-4" onClick={analyze} disabled={busy !== null}>
              {busy === "analyze" ? <LoaderCircle className="animate-spin" /> : <ShieldCheck />} Validate against the database
            </Button>
          </div>
        </section>
      )}

      {analysis && (
        <Review
          analysis={analysis}
          skip={skip}
          setSkip={setSkip}
          busy={busy === "commit"}
          onCommit={commit}
          onDownload={() => download(`import-issues-${loaded?.fileName ?? "file"}.csv`, issuesCsv(analysis.issues, analysis.teams))}
        />
      )}
    </div>
  );
}

function Preview({ table }: { table: PreparedTable }) {
  const rows = table.rows.slice(0, 8);
  return (
    <div className="overflow-x-auto rounded-lg border">
      <table className="text-xs">
        <thead className="bg-muted/50">
          <tr>
            <th className="px-2 py-1.5 text-left font-medium text-muted-foreground">Row</th>
            {table.headers.map((h, i) => (
              <th key={i} className="px-2 py-1.5 text-left font-medium whitespace-nowrap">
                <span className="text-muted-foreground">{i + 1}.</span> {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y">
          {rows.map((r) => (
            <tr key={r.rowNumber}>
              <td className="tabular px-2 py-1 text-muted-foreground">{r.rowNumber}</td>
              {r.cells.map((c, i) => (
                <td key={i} className="max-w-48 truncate px-2 py-1 whitespace-nowrap">
                  {c}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      <p className="border-t px-2 py-1.5 text-xs text-muted-foreground">
        Showing {rows.length} of {table.rows.length} data rows.
      </p>
    </div>
  );
}

function ColumnSelect({ table, value, onChange, label }: { table: PreparedTable; value: number | null; onChange: (v: number | null) => void; label: string }) {
  return (
    <NativeSelect value={value === null ? "" : String(value)} onChange={(e) => onChange(e.target.value === "" ? null : Number(e.target.value))} aria-label={label} className="min-w-40">
      <option value="">—</option>
      {table.headers.map((h, i) => {
        const sample = table.rows.find((r) => r.cells[i]?.trim())?.cells[i]?.trim();
        return (
          <option key={i} value={i}>
            {i + 1}. {h}
            {table.headerRow === null && sample ? ` (${sample.slice(0, 24)})` : ""}
          </option>
        );
      })}
    </NativeSelect>
  );
}

function SlotFields({ table, slot, onChange, label }: { table: PreparedTable; slot: Slot; onChange: (s: Slot) => void; label: string }) {
  return (
    <div className="grid grid-cols-[7rem_repeat(3,minmax(0,1fr))] items-center gap-2">
      <span className="text-sm font-medium">{label}</span>
      <ColumnSelect table={table} value={slot.name} onChange={(v) => onChange({ ...slot, name: v })} label={`${label} name`} />
      <ColumnSelect table={table} value={slot.email} onChange={(v) => onChange({ ...slot, email: v })} label={`${label} email`} />
      <ColumnSelect table={table} value={slot.phone} onChange={(v) => onChange({ ...slot, phone: v })} label={`${label} phone`} />
    </div>
  );
}

function MappingForm({ table, mapping, onChange }: { table: PreparedTable; mapping: Mapping; onChange: (p: Partial<Mapping>) => void }) {
  const field = (label: string, key: "teamName" | "teamCode" | "college" | "declaredSize" | "declaredRegistered" | "role") => (
    <div className="flex flex-col gap-1">
      <Label className="text-xs">{label}</Label>
      <ColumnSelect table={table} value={mapping[key]} onChange={(v) => onChange({ [key]: v })} label={label} />
    </div>
  );
  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-6">
        {field("Team name *", "teamName")}
        {field("Team code / ID", "teamCode")}
        {field("College / company", "college")}
        {field("Team size (declared)", "declaredSize")}
        {field("Registered count", "declaredRegistered")}
        {mapping.layout === "participant_row" && field("Leader flag column", "role")}
      </div>
      <div className="flex flex-col gap-2 rounded-lg border p-3">
        <div className="grid grid-cols-[7rem_repeat(3,minmax(0,1fr))] gap-2 text-xs font-medium text-muted-foreground">
          <span />
          <span>Name</span>
          <span>Email</span>
          <span>Phone</span>
        </div>
        {mapping.layout === "team_row" ? (
          <>
            <SlotFields table={table} slot={mapping.leader} onChange={(s) => onChange({ leader: s })} label="Leader" />
            {mapping.members.map((slot, i) => (
              <SlotFields key={i} table={table} slot={slot} onChange={(s) => onChange({ members: mapping.members.map((x, j) => (j === i ? s : x)) })} label={`Member ${i + 2}`} />
            ))}
            <div className="flex gap-2">
              <Button size="sm" variant="outline" onClick={() => onChange({ members: [...mapping.members, emptySlot()] })} disabled={mapping.members.length >= 20}>
                <Plus /> Member columns
              </Button>
              <Button size="sm" variant="ghost" onClick={() => onChange({ members: mapping.members.slice(0, -1) })} disabled={mapping.members.length === 0}>
                <Minus /> Remove last
              </Button>
            </div>
          </>
        ) : (
          <>
            <SlotFields table={table} slot={mapping.person} onChange={(s) => onChange({ person: s })} label="Participant" />
            <SlotFields table={table} slot={mapping.leader} onChange={(s) => onChange({ leader: s })} label="Team leader" />
            <p className="text-xs text-muted-foreground">Rows are grouped into teams by team code, else leader email, else team name. The leader is the row matching the leader columns or flagged in the leader column.</p>
          </>
        )}
      </div>
      <div className="grid gap-2 sm:grid-cols-[minmax(0,14rem)_minmax(0,1fr)] sm:items-end">
          <div className="flex flex-col gap-1">
            <Label className="text-xs">Exclude rows where column…</Label>
            <ColumnSelect table={table} value={mapping.exclude?.column ?? null} onChange={(v) => onChange({ exclude: v === null ? null : { column: v, values: mapping.exclude?.values ?? [] } })} label="Exclude column" />
          </div>
          <div className="flex flex-col gap-1">
            <Label className="text-xs">…equals one of (comma separated, e.g. cancelled, withdrawn)</Label>
            <Input
              disabled={!mapping.exclude}
              defaultValue={mapping.exclude?.values.join(", ") ?? ""}
              onBlur={(e) => mapping.exclude && onChange({ exclude: { ...mapping.exclude, values: e.target.value.split(",").map((v) => v.trim()).filter(Boolean) } })}
            />
          </div>
        </div>
    </div>
  );
}

function Review({
  analysis,
  skip,
  setSkip,
  busy,
  onCommit,
  onDownload,
}: {
  analysis: ImportAnalysis;
  skip: Set<string>;
  setSkip: (s: Set<string>) => void;
  busy: boolean;
  onCommit: () => void;
  onDownload: () => void;
}) {
  const [severity, setSeverity] = useState<"all" | "error" | "warning" | "info">("all");
  const [action, setAction] = useState<"all" | TeamAction>("all");
  const s = analysis.summary;
  const importable = analysis.teams.filter((t) => (t.action === "create" || t.action === "update") && !skip.has(t.key));
  const participants = importable.reduce((n, t) => n + (t.action === "create" ? t.members.length : t.memberChanges.filter((c) => c.kind === "add").length), 0);
  const issues = analysis.issues.filter((i) => severity === "all" || i.severity === severity);
  const teams = analysis.teams.filter((t) => action === "all" || t.action === action);

  return (
    <section className="flex flex-col gap-4 rounded-xl border bg-card p-4">
      <h2 className="font-semibold">3. Review and import</h2>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-8">
        {[
          ["Rows read", s.totalRows],
          ["Teams in file", s.teamsInFile],
          ["Participants in file", s.participantsInFile],
          ["New teams", s.create],
          ["Teams to update", s.update],
          ["Unchanged / existing", s.unchanged + s.skipExisting],
          ["Errors", s.errors + s.blocked],
          ["Warnings", s.warnings],
        ].map(([label, value]) => (
          <div key={label} className="rounded-lg border p-2.5">
            <p className="text-xs text-muted-foreground">{label}</p>
            <p className="tabular text-xl font-semibold">{value}</p>
          </div>
        ))}
      </div>

      <div className="rounded-lg border">
        <div className="flex flex-wrap items-center gap-2 border-b px-3 py-2">
          <h3 className="mr-auto text-sm font-semibold">Validation issues ({analysis.issues.length})</h3>
          <NativeSelect value={severity} onChange={(e) => setSeverity(e.target.value as typeof severity)} className="w-40" aria-label="Severity">
            <option value="all">All</option>
            <option value="error">Errors</option>
            <option value="warning">Warnings</option>
            <option value="info">Info</option>
          </NativeSelect>
          <Button size="sm" variant="outline" onClick={onDownload}>
            <Download /> Error report (CSV)
          </Button>
        </div>
        {issues.length === 0 ? (
          <p className="px-3 py-4 text-sm text-muted-foreground">No issues.</p>
        ) : (
          <ul className="max-h-80 divide-y overflow-y-auto text-sm">
            {issues.map((i, k) => (
              <li key={k} className="flex gap-2 px-3 py-1.5">
                {i.severity === "error" ? (
                  <CircleAlert className="mt-0.5 size-4 shrink-0 text-destructive" aria-label="Error" />
                ) : i.severity === "warning" ? (
                  <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warning" aria-label="Warning" />
                ) : (
                  <Info className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-label="Info" />
                )}
                <span>
                  <span className="text-xs text-muted-foreground">row {i.rowNumbers.join(", ")} · </span>
                  {i.team && <span className="font-medium">{i.team}: </span>}
                  {i.message}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="rounded-lg border">
        <div className="flex flex-wrap items-center gap-2 border-b px-3 py-2">
          <h3 className="mr-auto text-sm font-semibold">Teams ({analysis.teams.length})</h3>
          <NativeSelect value={action} onChange={(e) => setAction(e.target.value as typeof action)} className="w-44" aria-label="Filter teams">
            <option value="all">All</option>
            {(Object.keys(ACTION_LABEL) as TeamAction[]).map((a) => (
              <option key={a} value={a}>
                {ACTION_LABEL[a]}
              </option>
            ))}
          </NativeSelect>
        </div>
        <ul className="max-h-[28rem] divide-y overflow-y-auto text-sm">
          {teams.map((t) => {
            const selectable = t.action === "create" || t.action === "update";
            return (
              <li key={t.key} className="flex gap-3 px-3 py-2">
                <Checkbox
                  className="mt-0.5"
                  checked={selectable && !skip.has(t.key)}
                  disabled={!selectable}
                  onCheckedChange={(v) => {
                    const next = new Set(skip);
                    if (v) next.delete(t.key);
                    else next.add(t.key);
                    setSkip(next);
                  }}
                  aria-label={`Import ${t.teamName}`}
                />
                <div className="min-w-0 flex-1">
                  <p className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{t.teamName}</span>
                    <span className="font-mono text-xs text-muted-foreground">{t.finalCode}</span>
                    <Pill t={ACTION_TONE[skip.has(t.key) ? "deselected" : t.action]}>{ACTION_LABEL[skip.has(t.key) ? "deselected" : t.action]}</Pill>
                    <span className="text-xs text-muted-foreground">
                      {t.members.length} member{t.members.length === 1 ? "" : "s"} · row {t.rowNumbers.join(", ")}
                    </span>
                  </p>
                  <p className="truncate text-xs text-muted-foreground">{t.members.map((m) => `${m.isLeader ? "★ " : ""}${m.name}`).join(", ")}</p>
                  {t.blockReason && <p className="text-xs font-medium text-destructive">{t.blockReason}</p>}
                  {t.changes.length + t.memberChanges.length > 0 && (
                    <p className="text-xs text-warning-foreground">{[...t.changes, ...t.memberChanges.map((c) => `${c.name}: ${c.detail}`)].join(" · ")}</p>
                  )}
                  {t.warnings.map((w, k) => (
                    <p key={k} className="text-xs text-warning-foreground">
                      {w}
                    </p>
                  ))}
                </div>
              </li>
            );
          })}
        </ul>
      </div>

      <div className="flex flex-wrap items-center gap-3 border-t pt-4">
        <Button size="lg" className="h-11 px-5 text-base" disabled={busy || importable.length === 0} onClick={onCommit}>
          {busy ? <LoaderCircle className="animate-spin" /> : <CircleCheckBig />}
          Import {importable.length} team{importable.length === 1 ? "" : "s"} · {participants} participant{participants === 1 ? "" : "s"}
        </Button>
        <p className="text-sm text-muted-foreground">Everything is written in one transaction: if anything fails, nothing is saved.</p>
      </div>
    </section>
  );
}

function ImportDone({ report, onAgain }: { report: ImportReport; onAgain: () => void }) {
  const s = report.summary;
  return (
    <section className="flex flex-col gap-4 rounded-xl border bg-card p-6">
      <div className="flex items-center gap-3">
        <CircleCheckBig className="size-8 text-success" aria-hidden />
        <div>
          <h2 className="text-lg font-semibold">Import complete</h2>
          <p className="text-sm text-muted-foreground">
            {s.create} teams created, {s.update} updated, {s.participantsToCreate} participants added, {s.participantsToUpdate} participant records updated.
            {s.unchanged + s.skipExisting > 0 && ` ${s.unchanged + s.skipExisting} existing teams left unchanged.`}
            {s.blocked > 0 && ` ${s.blocked} blocked.`} {s.errors} errors, {s.warnings} warnings.
          </p>
        </div>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button nativeButton={false} render={<Link href="/teams" />}>
          View teams
        </Button>
        <Button variant="outline" onClick={() => download(`import-report-${report.importId.slice(0, 8)}.csv`, issuesCsv(report.issues, report.teams))}>
          <Download /> Download report
        </Button>
        <Button variant="ghost" onClick={onAgain}>
          <RotateCcw /> Import another file
        </Button>
      </div>
    </section>
  );
}

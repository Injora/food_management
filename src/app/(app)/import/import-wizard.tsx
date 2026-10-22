"use client";

import Link from "next/link";
import { useMemo, useRef, useState } from "react";
import Papa from "papaparse";
import {
  CircleAlert,
  CircleCheckBig,
  Download,
  FileUp,
  LoaderCircle,
  RotateCcw,
  ShieldCheck,
  TriangleAlert,
} from "lucide-react";
import { toast } from "sonner";
import { cn } from "cn";

import { NativeSelect } from "@/components/native-select";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { callAction } from "@/lib/client-fetch";
import { toCsv } from "@/lib/csv";
import {
  cleanText,
  DEFAULT_MAX_TEAM_SIZE,
  detectImportSetup,
  MAX_IMPORT_ROWS,
  type DetectedSetup,
  type ParsedTable,
} from "@/lib/csv-import";
import { analyzeImportAction, commitImportAction } from "@/server/actions/import";
import type { AnalyzedTeam, ImportAnalysis, ImportMode, ImportReport, ImportRequest } from "@/server/services/import";

const MAX_FILE_BYTES = 20 * 1024 * 1024;

type Parsed = { fileName: string; table: ParsedTable; warnings: string[] };

function parseFile(file: File): Promise<Parsed> {
  return new Promise((resolve, reject) => {
    if (file.size === 0) return reject(new Error("The file is empty."));
    if (file.size > MAX_FILE_BYTES) return reject(new Error("The file is larger than 20 MB."));
    Papa.parse<string[]>(file, {
      skipEmptyLines: "greedy",
      complete: (res) => {
        const [rawHeaders, ...rows] = res.data;
        if (!rawHeaders || rawHeaders.every((h) => !cleanText(h))) return reject(new Error("The file is empty or has no header row."));
        if (rows.length === 0) return reject(new Error("The file has a header row but no data rows."));
        if (rows.length > MAX_IMPORT_ROWS) return reject(new Error(`The file has ${rows.length} rows; the limit is ${MAX_IMPORT_ROWS}.`));

        // Blank and repeated headers would make the mapping ambiguous.
        const seen = new Map<string, number>();
        const headers = rawHeaders.map((h, i) => {
          const base = cleanText(h.replace(/^﻿/, "")) ?? `Column ${i + 1}`;
          const n = (seen.get(base) ?? 0) + 1;
          seen.set(base, n);
          return n === 1 ? base : `${base} (${n})`;
        });
        const width = headers.length;
        let ragged = 0;
        const normalized = rows.map((r) => {
          if (r.length !== width) ragged++;
          return r.length >= width ? r.slice(0, width) : [...r, ...Array(width - r.length).fill("")];
        });

        const warnings: string[] = [];
        const quoteErrors = res.errors.filter((e) => e.type === "Quotes");
        if (quoteErrors.length > 0) {
          warnings.push(`${quoteErrors.length} row(s) have unbalanced quotes (first near row ${(quoteErrors[0].row ?? 0) + 1}). Check those rows in the preview.`);
        }
        if (ragged > 0) warnings.push(`${ragged} row(s) have a different number of columns than the header; missing cells were treated as blank.`);
        resolve({ fileName: file.name, table: { headers, rows: normalized }, warnings });
      },
      error: (err) => reject(new Error(`Could not read the file: ${err.message}`)),
    });
  });
}

/** Sends only the mapped columns to keep the request small. */
function project(table: ParsedTable, setup: DetectedSetup): ParsedTable {
  const m = setup.mapping;
  const wanted = new Set(
    [m.teamName, m.teamCode, m.leaderName, m.leaderEmail, setup.countMode === "column" ? m.memberCount : null, setup.countMode === "unique_members" ? m.memberIdColumn : null, setup.exclude?.values.length ? setup.exclude.column : null]
      .concat(setup.countMode === "member_columns" ? m.memberNameColumns : [])
      .filter((c): c is string => !!c),
  );
  const idx = table.headers.map((h, i) => (wanted.has(h) ? i : -1)).filter((i) => i >= 0);
  return { headers: idx.map((i) => table.headers[i]), rows: table.rows.map((r) => idx.map((i) => r[i] ?? "")) };
}

function errorReportCsv(a: ImportAnalysis): string {
  const rows: (string | number | null)[][] = [["type", "rows", "team_name", "team_code", "reason"]];
  for (const r of a.invalidRows) rows.push(["invalid_row", r.rowNumber, r.teamName, null, r.reason]);
  for (const r of a.rejected) rows.push([r.kind === "duplicate" ? "duplicate" : "invalid_team", r.rowNumbers.join(" "), r.teamName, r.teamCode, r.reason]);
  for (const t of a.teams.filter((x) => x.action === "blocked")) rows.push(["blocked", t.rowNumbers.join(" "), t.teamName, t.teamCode, t.blockReason]);
  for (const t of a.teams.filter((x) => x.warnings.length > 0)) rows.push(["warning", t.rowNumbers.join(" "), t.teamName, t.teamCode, t.warnings.join("; ")]);
  return toCsv(rows);
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
  const [parsed, setParsed] = useState<Parsed | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);
  const [setup, setSetup] = useState<DetectedSetup | null>(null);
  const [mode, setMode] = useState<ImportMode>("add_only");
  const [analysis, setAnalysis] = useState<ImportAnalysis | null>(null);
  const [skipKeys, setSkipKeys] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<"analyze" | "commit" | null>(null);
  const [serverError, setServerError] = useState<string | null>(null);
  const [report, setReport] = useState<ImportReport | null>(null);
  const [dragging, setDragging] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const reset = () => {
    setParsed(null);
    setParseError(null);
    setSetup(null);
    setAnalysis(null);
    setReport(null);
    setServerError(null);
    setSkipKeys(new Set());
    if (fileRef.current) fileRef.current.value = "";
  };

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    reset();
    try {
      const p = await parseFile(file);
      setParsed(p);
      setSetup(detectImportSetup(p.table));
    } catch (err) {
      setParseError(err instanceof Error ? err.message : "Could not read the file.");
    }
  };

  // Any change to the configuration invalidates the previous validation.
  const update = (fn: (s: DetectedSetup) => DetectedSetup) => {
    setSetup((s) => (s ? fn(s) : s));
    setAnalysis(null);
    setServerError(null);
  };

  const buildRequest = (): ImportRequest | null =>
    parsed && setup ? { fileName: parsed.fileName, table: project(parsed.table, setup), options: setup, mode, skipKeys: [...skipKeys] } : null;

  const analyze = async () => {
    const req = buildRequest();
    if (!req) return;
    setBusy("analyze");
    setServerError(null);
    const res = await callAction(() => analyzeImportAction({ ...req, skipKeys: [] }));
    setBusy(null);
    if (res.ok) {
      setAnalysis(res.data);
      setSkipKeys(new Set());
    } else setServerError(res.error.message);
  };

  const commit = async () => {
    const req = buildRequest();
    if (!req) return;
    setBusy("commit");
    setServerError(null);
    const res = await callAction(() => commitImportAction(req));
    setBusy(null);
    if (res.ok) {
      setReport(res.data);
      toast.success(`Import complete: ${res.data.summary.create} created, ${res.data.summary.update} updated`);
    } else {
      setServerError(
        res.error.code === "NETWORK"
          ? "Connection lost during import. Validate again to see whether it was applied; re-importing never duplicates teams."
          : `${res.error.message} Nothing was imported.`,
      );
    }
  };

  if (report) return <ImportReportView report={report} onDone={reset} />;

  return (
    <div className="flex flex-col gap-6">
      {/* Step 1: upload */}
      <Step n={1} title="Upload CSV" done={!!parsed}>
        <label
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragging(false);
            void onFile(e.dataTransfer.files[0]);
          }}
          className={cn(
            "flex cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed px-6 py-8 text-center transition-colors focus-within:ring-3 focus-within:ring-ring/50",
            dragging ? "border-primary bg-accent" : "hover:bg-muted/50",
          )}
        >
          <FileUp className="size-7 text-muted-foreground" aria-hidden />
          <span className="font-medium">{parsed ? parsed.fileName : "Choose a CSV file or drop it here"}</span>
          <span className="text-sm text-muted-foreground">
            {parsed ? `${parsed.table.rows.length} rows · ${parsed.table.headers.length} columns` : "UTF-8 CSV with a header row, up to 20 MB"}
          </span>
          <input ref={fileRef} type="file" accept=".csv,text/csv" className="sr-only" onChange={(e) => void onFile(e.target.files?.[0])} />
        </label>
        {parseError && <Alert tone="error">{parseError}</Alert>}
        {parsed?.warnings.map((w) => (
          <Alert key={w} tone="warning">
            {w}
          </Alert>
        ))}
      </Step>

      {parsed && setup && (
        <>
          <Step n={2} title="Preview" done>
            <Preview table={parsed.table} highlight={setup} />
          </Step>

          <Step n={3} title="Map columns" done={!!analysis}>
            <MappingForm headers={parsed.table.headers} table={parsed.table} setup={setup} update={update} mode={mode} setMode={(m) => { setMode(m); setAnalysis(null); }} />
            <div className="flex flex-wrap items-center gap-2">
              <Button size="lg" onClick={analyze} disabled={busy !== null}>
                {busy === "analyze" ? <LoaderCircle className="animate-spin" /> : <ShieldCheck />} Validate
              </Button>
              <Button variant="ghost" onClick={reset} disabled={busy !== null}>
                <RotateCcw /> Start over
              </Button>
            </div>
            {serverError && !analysis && <Alert tone="error">{serverError}</Alert>}
          </Step>

          {analysis && (
            <Step n={4} title="Review and confirm" done={false}>
              <AnalysisView
                analysis={analysis}
                skipKeys={skipKeys}
                toggle={(key) =>
                  setSkipKeys((s) => {
                    const next = new Set(s);
                    if (next.has(key)) next.delete(key);
                    else next.add(key);
                    return next;
                  })
                }
              />
              {serverError && <Alert tone="error">{serverError}</Alert>}
              <div className="flex flex-wrap items-center gap-2 border-t pt-4">
                {(() => {
                  const creates = analysis.teams.filter((t) => t.action === "create" && !skipKeys.has(t.key)).length;
                  const updates = analysis.teams.filter((t) => t.action === "update" && !skipKeys.has(t.key)).length;
                  return (
                    <Button size="lg" onClick={commit} disabled={busy !== null || creates + updates === 0}>
                      {busy === "commit" ? <LoaderCircle className="animate-spin" /> : <CircleCheckBig />}
                      {creates + updates === 0 ? "Nothing to import" : `Import ${creates} new${mode === "update_existing" ? `, update ${updates}` : ""}`}
                    </Button>
                  );
                })()}
                <Button variant="outline" onClick={() => download(`import-issues-${parsed.fileName}`, errorReportCsv(analysis))}>
                  <Download /> Download issues
                </Button>
              </div>
            </Step>
          )}
        </>
      )}
    </div>
  );
}

function Step({ n, title, done, children }: { n: number; title: string; done: boolean; children: React.ReactNode }) {
  return (
    <section className="rounded-xl border bg-card p-4 sm:p-5">
      <h2 className="mb-4 flex items-center gap-2.5 font-semibold">
        <span
          className={cn(
            "flex size-6 items-center justify-center rounded-full text-xs font-bold",
            done ? "bg-success text-white" : "bg-primary text-primary-foreground",
          )}
        >
          {done ? <CircleCheckBig className="size-3.5" aria-label="done" /> : n}
        </span>
        {title}
      </h2>
      <div className="flex flex-col gap-4">{children}</div>
    </section>
  );
}

function Alert({ tone, children }: { tone: "error" | "warning"; children: React.ReactNode }) {
  const Icon = tone === "error" ? CircleAlert : TriangleAlert;
  return (
    <p
      role={tone === "error" ? "alert" : "status"}
      className={cn(
        "flex items-start gap-2 rounded-lg px-3 py-2 text-sm",
        tone === "error" ? "bg-destructive/10 text-destructive" : "bg-warning-soft text-warning-foreground",
      )}
    >
      <Icon className="mt-0.5 size-4 shrink-0" aria-hidden />
      <span>{children}</span>
    </p>
  );
}

function Preview({ table, highlight }: { table: ParsedTable; highlight: DetectedSetup }) {
  const mapped = new Set([highlight.mapping.teamName, highlight.mapping.teamCode, highlight.mapping.memberCount, highlight.mapping.leaderName, highlight.mapping.leaderEmail, ...highlight.mapping.memberNameColumns]);
  return (
    <div className="overflow-x-auto rounded-lg border">
      <table className="w-max min-w-full text-xs">
        <thead className="bg-muted/60">
          <tr>
            <th className="px-2 py-1.5 text-left font-medium text-muted-foreground">#</th>
            {table.headers.map((h) => (
              <th key={h} className={cn("max-w-48 truncate px-2 py-1.5 text-left font-medium", mapped.has(h) ? "text-primary" : "text-muted-foreground")}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y">
          {table.rows.slice(0, 8).map((r, i) => (
            <tr key={i}>
              <td className="tabular px-2 py-1 text-muted-foreground">{i + 2}</td>
              {r.map((c, j) => (
                <td key={j} className="max-w-48 truncate px-2 py-1">
                  {c}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      <p className="border-t px-2 py-1.5 text-xs text-muted-foreground">Showing the first {Math.min(8, table.rows.length)} of {table.rows.length} rows. Mapped columns are highlighted.</p>
    </div>
  );
}

function ColumnSelect({ id, label, value, headers, onChange, optional = true }: { id: string; label: string; value: string | null | undefined; headers: string[]; onChange: (v: string | null) => void; optional?: boolean }) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <NativeSelect id={id} value={value ?? ""} onChange={(e) => onChange(e.target.value || null)}>
        {optional && <option value="">— Not in file —</option>}
        {headers.map((h) => (
          <option key={h} value={h}>
            {h}
          </option>
        ))}
      </NativeSelect>
    </div>
  );
}

function MappingForm({
  headers,
  table,
  setup,
  update,
  mode,
  setMode,
}: {
  headers: string[];
  table: ParsedTable;
  setup: DetectedSetup;
  update: (fn: (s: DetectedSetup) => DetectedSetup) => void;
  mode: ImportMode;
  setMode: (m: ImportMode) => void;
}) {
  const m = setup.mapping;
  const setMap = (patch: Partial<DetectedSetup["mapping"]>) => update((s) => ({ ...s, mapping: { ...s.mapping, ...patch } }));
  const excludeValues = useMemo(() => {
    if (!setup.exclude) return [];
    const idx = headers.indexOf(setup.exclude.column);
    const counts = new Map<string, number>();
    for (const r of table.rows) {
      const v = (cleanText(r[idx]) ?? "").toLowerCase();
      counts.set(v, (counts.get(v) ?? 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 30);
  }, [setup.exclude, headers, table.rows]);

  return (
    <div className="flex flex-col gap-5">
      <fieldset className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <legend className="mb-2 text-sm font-medium">Team fields</legend>
        <ColumnSelect id="map-name" label="Team name (required)" value={m.teamName} headers={headers} optional={false} onChange={(v) => setMap({ teamName: v ?? headers[0] })} />
        <ColumnSelect id="map-code" label="Team code" value={m.teamCode} headers={headers} onChange={(v) => setMap({ teamCode: v })} />
        <ColumnSelect id="map-leader" label="Team leader name" value={m.leaderName} headers={headers} onChange={(v) => setMap({ leaderName: v })} />
        <ColumnSelect id="map-email" label="Team leader email" value={m.leaderEmail} headers={headers} onChange={(v) => setMap({ leaderEmail: v })} />
      </fieldset>

      <fieldset className="flex flex-col gap-3">
        <legend className="mb-2 text-sm font-medium">How is the team size given?</legend>
        <div className="grid gap-2 md:grid-cols-3">
          {(
            [
              ["column", "A team size column", "e.g. member_count = 4"],
              ["member_columns", "Member name columns", "Count filled-in names per row"],
              ["unique_members", "One row per member", "Count unique members per team"],
            ] as const
          ).map(([value, title, hint]) => (
            <label key={value} className={cn("flex cursor-pointer gap-2.5 rounded-lg border p-3 text-sm", setup.countMode === value && "border-primary bg-accent/60")}>
              <input
                type="radio"
                name="countMode"
                className="mt-0.5 accent-[var(--primary)]"
                checked={setup.countMode === value}
                onChange={() => update((s) => ({ ...s, countMode: value, rowsPerTeam: value === "unique_members" ? "many" : s.rowsPerTeam }))}
              />
              <span>
                <span className="block font-medium">{title}</span>
                <span className="text-muted-foreground">{hint}</span>
              </span>
            </label>
          ))}
        </div>
        {setup.countMode === "column" && (
          <div className="sm:max-w-xs">
            <ColumnSelect id="map-count" label="Team size column" value={m.memberCount} headers={headers} onChange={(v) => setMap({ memberCount: v })} />
          </div>
        )}
        {setup.countMode === "member_columns" && (
          <div className="flex flex-col gap-1.5">
            <p className="text-sm">Columns holding member names (include the leader&apos;s column if the leader is a member):</p>
            <div className="grid max-h-56 gap-1 overflow-y-auto rounded-lg border p-2 sm:grid-cols-2 lg:grid-cols-3">
              {headers.map((h) => (
                <label key={h} className="flex items-center gap-2 rounded px-1.5 py-1 text-sm hover:bg-muted">
                  <Checkbox
                    checked={m.memberNameColumns.includes(h)}
                    onCheckedChange={(v) =>
                      setMap({ memberNameColumns: v ? [...m.memberNameColumns, h] : m.memberNameColumns.filter((c) => c !== h) })
                    }
                  />
                  <span className="truncate">{h}</span>
                </label>
              ))}
            </div>
          </div>
        )}
        {setup.countMode === "unique_members" && (
          <div className="sm:max-w-xs">
            <ColumnSelect id="map-member" label="Member identifier (e.g. email)" value={m.memberIdColumn} headers={headers} onChange={(v) => setMap({ memberIdColumn: v })} />
          </div>
        )}
      </fieldset>

      <fieldset className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <legend className="mb-2 text-sm font-medium">Rows and limits</legend>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="rows-per-team">Rows per team</Label>
          <NativeSelect
            id="rows-per-team"
            value={setup.rowsPerTeam}
            disabled={setup.countMode === "unique_members"}
            onChange={(e) => update((s) => ({ ...s, rowsPerTeam: e.target.value as "one" | "many" }))}
          >
            <option value="one">One row per team (repeats are duplicates)</option>
            <option value="many">Several rows per team (merge them)</option>
          </NativeSelect>
        </div>
        {setup.rowsPerTeam === "many" && (
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="group-by">Merge rows that share</Label>
            <NativeSelect id="group-by" value={setup.groupBy} onChange={(e) => update((s) => ({ ...s, groupBy: e.target.value as DetectedSetup["groupBy"] }))}>
              <option value="team_name">Team name (ignoring case and spacing)</option>
              <option value="team_code" disabled={!m.teamCode}>Team code</option>
              <option value="leader_email" disabled={!m.leaderEmail}>Leader email</option>
            </NativeSelect>
          </div>
        )}
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="max-size">Maximum team size</Label>
          <Input
            id="max-size"
            type="number"
            min={1}
            max={1000}
            value={setup.maxTeamSize}
            onChange={(e) => update((s) => ({ ...s, maxTeamSize: Math.max(1, Math.min(1000, Number(e.target.value) || DEFAULT_MAX_TEAM_SIZE)) }))}
          />
        </div>
      </fieldset>

      <fieldset className="flex flex-col gap-2">
        <legend className="mb-2 text-sm font-medium">Exclude rows (optional)</legend>
        <div className="sm:max-w-xs">
          <ColumnSelect
            id="exclude-col"
            label="Skip rows where this column…"
            value={setup.exclude?.column}
            headers={headers}
            onChange={(v) => update((s) => ({ ...s, exclude: v ? { column: v, values: [] } : null }))}
          />
        </div>
        {setup.exclude && (
          <div className="flex flex-wrap gap-1.5">
            <span className="w-full text-sm text-muted-foreground">…has one of these values:</span>
            {excludeValues.map(([value, count]) => {
              const on = setup.exclude!.values.includes(value);
              return (
                <button
                  key={value}
                  type="button"
                  aria-pressed={on}
                  onClick={() =>
                    update((s) => ({
                      ...s,
                      exclude: { column: s.exclude!.column, values: on ? s.exclude!.values.filter((x) => x !== value) : [...s.exclude!.values, value] },
                    }))
                  }
                  className={cn(
                    "rounded-full border px-3 py-1 text-sm outline-none focus-visible:ring-3 focus-visible:ring-ring/50",
                    on ? "border-destructive/40 bg-destructive/10 text-destructive line-through" : "hover:bg-muted",
                  )}
                >
                  {value || "(blank)"} <span className="tabular text-xs opacity-70">{count}</span>
                </button>
              );
            })}
          </div>
        )}
      </fieldset>

      <fieldset className="flex flex-col gap-2">
        <legend className="mb-2 text-sm font-medium">Import mode</legend>
        <div className="grid gap-2 md:grid-cols-2">
          {(
            [
              ["add_only", "Add new teams only", "Teams that already exist are left untouched."],
              ["update_existing", "Add new and update existing", "Existing teams are updated only if no meal has been issued to them yet."],
            ] as const
          ).map(([value, title, hint]) => (
            <label key={value} className={cn("flex cursor-pointer gap-2.5 rounded-lg border p-3 text-sm", mode === value && "border-primary bg-accent/60")}>
              <input type="radio" name="mode" className="mt-0.5 accent-[var(--primary)]" checked={mode === value} onChange={() => setMode(value)} />
              <span>
                <span className="block font-medium">{title}</span>
                <span className="text-muted-foreground">{hint}</span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>
    </div>
  );
}

const ACTION_LABEL: Record<AnalyzedTeam["action"], string> = {
  create: "New",
  update: "Update",
  unchanged: "Unchanged",
  skip_existing: "Exists",
  blocked: "Blocked",
  deselected: "Skipped",
};

function AnalysisView({ analysis, skipKeys, toggle }: { analysis: ImportAnalysis; skipKeys: Set<string>; toggle: (key: string) => void }) {
  const s = analysis.summary;
  const [tab, setTab] = useState<"apply" | "warnings" | "existing" | "problems">("apply");
  const apply = analysis.teams.filter((t) => t.action === "create" || t.action === "update");
  const warned = analysis.teams.filter((t) => t.warnings.length > 0);
  const existing = analysis.teams.filter((t) => t.action === "unchanged" || t.action === "skip_existing" || t.action === "blocked");
  const problems = analysis.invalidRows.length + analysis.rejected.length;

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
        <Tile label="Rows read" value={s.totalRows} hint={s.excludedRows ? `${s.excludedRows} excluded` : undefined} />
        <Tile label="Teams found" value={s.teamsInFile} />
        <Tile label="New teams" value={s.create} tone="success" hint={`${s.membersToCreate} members`} />
        <Tile label={analysis.mode === "update_existing" ? "Updates" : "Already exist"} value={analysis.mode === "update_existing" ? s.update : s.skipExisting} />
        <Tile label="Need review" value={s.withWarnings + s.blocked} tone={s.withWarnings + s.blocked ? "warning" : undefined} hint={s.blocked ? `${s.blocked} blocked` : undefined} />
        <Tile label="Rejected" value={problems} tone={problems ? "error" : undefined} hint={`${s.invalidRows} rows, ${s.duplicates} duplicates`} />
      </div>

      <div role="tablist" className="flex flex-wrap gap-1 rounded-lg bg-muted p-0.5 text-sm">
        {(
          [
            ["apply", `To import (${apply.length})`],
            ["warnings", `Warnings (${warned.length})`],
            ["existing", `Existing (${existing.length})`],
            ["problems", `Rejected (${problems})`],
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            role="tab"
            type="button"
            aria-selected={tab === key}
            onClick={() => setTab(key)}
            className={cn("h-8 rounded-md px-3 font-medium", tab === key ? "bg-background shadow-xs" : "text-muted-foreground hover:text-foreground")}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="max-h-[28rem] overflow-auto rounded-lg border">
        {tab === "problems" ? (
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-muted text-left text-xs text-muted-foreground">
              <tr>
                <th className="px-3 py-2 font-medium">Row</th>
                <th className="px-3 py-2 font-medium">Team</th>
                <th className="px-3 py-2 font-medium">Problem</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {analysis.invalidRows.map((r) => (
                <tr key={`r${r.rowNumber}`}>
                  <td className="tabular px-3 py-1.5">{r.rowNumber}</td>
                  <td className="px-3 py-1.5">{r.teamName ?? "—"}</td>
                  <td className="px-3 py-1.5 text-destructive">{r.reason}</td>
                </tr>
              ))}
              {analysis.rejected.map((r, i) => (
                <tr key={`x${i}`}>
                  <td className="tabular px-3 py-1.5">{r.rowNumbers.join(", ")}</td>
                  <td className="px-3 py-1.5">{r.teamName}</td>
                  <td className="px-3 py-1.5 text-destructive">{r.reason}</td>
                </tr>
              ))}
              {problems === 0 && <EmptyRow cols={3} text="No rejected rows." />}
            </tbody>
          </table>
        ) : (
          <TeamTable
            teams={tab === "apply" ? apply : tab === "warnings" ? warned : existing}
            skipKeys={skipKeys}
            toggle={toggle}
            selectable={tab === "apply" || tab === "warnings"}
          />
        )}
      </div>
      {tab === "apply" && apply.length > 0 && <p className="text-xs text-muted-foreground">Untick a team to leave it out of this import.</p>}
    </div>
  );
}

function EmptyRow({ cols, text }: { cols: number; text: string }) {
  return (
    <tr>
      <td colSpan={cols} className="px-3 py-6 text-center text-muted-foreground">
        {text}
      </td>
    </tr>
  );
}

function TeamTable({ teams, skipKeys, toggle, selectable }: { teams: AnalyzedTeam[]; skipKeys: Set<string>; toggle: (k: string) => void; selectable: boolean }) {
  return (
    <table className="w-full text-sm">
      <thead className="sticky top-0 z-10 bg-muted text-left text-xs text-muted-foreground">
        <tr>
          {selectable && <th className="w-10 px-3 py-2"><span className="sr-only">Include</span></th>}
          <th className="px-3 py-2 font-medium">Team</th>
          <th className="px-3 py-2 text-right font-medium">Members</th>
          <th className="px-3 py-2 font-medium">Result</th>
          <th className="px-3 py-2 font-medium">Notes</th>
        </tr>
      </thead>
      <tbody className="divide-y">
        {teams.map((t) => {
          const applicable = t.action === "create" || t.action === "update";
          return (
            <tr key={t.key} className={cn(skipKeys.has(t.key) && "opacity-50")}>
              {selectable && (
                <td className="px-3 py-1.5">
                  {applicable && (
                    <Checkbox aria-label={`Include ${t.teamName}`} checked={!skipKeys.has(t.key)} onCheckedChange={() => toggle(t.key)} />
                  )}
                </td>
              )}
              <td className="px-3 py-1.5">
                <span className="font-medium">{t.teamName}</span> <span className="font-mono text-xs text-muted-foreground">{t.teamCode}</span>
                <span className="block text-xs text-muted-foreground">
                  {t.leaderName ?? "no leader"} · rows {t.rowNumbers.slice(0, 6).join(", ")}
                  {t.rowNumbers.length > 6 && "…"}
                </span>
              </td>
              <td className="tabular px-3 py-1.5 text-right font-semibold">{t.memberCount}</td>
              <td className="px-3 py-1.5">
                <span
                  className={cn(
                    "rounded-full px-2 py-0.5 text-xs font-medium",
                    t.action === "create" && "bg-success-soft text-success-foreground",
                    t.action === "update" && "bg-accent text-accent-foreground",
                    t.action === "blocked" && "bg-destructive/10 text-destructive",
                    (t.action === "unchanged" || t.action === "skip_existing" || t.action === "deselected") && "bg-muted text-muted-foreground",
                  )}
                >
                  {skipKeys.has(t.key) ? "Skipped" : ACTION_LABEL[t.action]}
                </span>
              </td>
              <td className="px-3 py-1.5 text-xs">
                {t.blockReason && <p className="text-destructive">{t.blockReason}</p>}
                {t.changes.length > 0 && (
                  <p className="text-muted-foreground">{t.changes.map((c) => `${c.field}: ${String(c.from ?? "—")} → ${String(c.to)}`).join(" · ")}</p>
                )}
                {t.warnings.map((w) => (
                  <p key={w} className="text-warning-foreground">
                    {w}
                  </p>
                ))}
              </td>
            </tr>
          );
        })}
        {teams.length === 0 && <EmptyRow cols={selectable ? 5 : 4} text="Nothing here." />}
      </tbody>
    </table>
  );
}

function Tile({ label, value, hint, tone }: { label: string; value: number; hint?: string; tone?: "success" | "warning" | "error" }) {
  return (
    <div className="rounded-lg border bg-background px-3 py-2">
      <p className="text-[11px] font-semibold tracking-wider text-muted-foreground uppercase">{label}</p>
      <p
        className={cn(
          "tabular text-xl font-semibold",
          tone === "success" && "text-success-foreground",
          tone === "warning" && "text-warning-foreground",
          tone === "error" && "text-destructive",
        )}
      >
        {value}
      </p>
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

function ImportReportView({ report, onDone }: { report: ImportReport; onDone: () => void }) {
  const s = report.summary;
  const issues = s.invalidRows + s.duplicates + s.invalidTeams + s.blocked + s.withWarnings;
  return (
    <section className="rounded-xl border bg-card p-5">
      <div className="flex items-start gap-3">
        <CircleCheckBig className="size-7 shrink-0 text-success" aria-hidden />
        <div>
          <h2 className="text-lg font-semibold">Import complete</h2>
          <p className="text-sm text-muted-foreground">
            Saved to the database. Every new team has pending breakfast, lunch and dinner coupons equal to its member count.
          </p>
        </div>
      </div>
      <div className="mt-5 grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Tile label="Created" value={s.create} tone="success" hint={`${s.membersToCreate} members`} />
        <Tile label="Updated" value={s.update} />
        <Tile label="Left unchanged" value={s.unchanged + s.skipExisting + s.deselected} />
        <Tile label="Not imported" value={s.invalidRows + s.duplicates + s.invalidTeams + s.blocked} tone={s.blocked + s.duplicates + s.invalidRows ? "error" : undefined} />
      </div>
      <div className="mt-5 flex flex-wrap gap-2">
        <Button nativeButton={false} render={<Link href="/teams" />}>
          View teams
        </Button>
        {issues > 0 && (
          <Button variant="outline" onClick={() => download("import-report-issues.csv", errorReportCsv(report))}>
            <Download /> Download error details
          </Button>
        )}
        <Button variant="ghost" onClick={onDone}>
          Import another file
        </Button>
      </div>
    </section>
  );
}

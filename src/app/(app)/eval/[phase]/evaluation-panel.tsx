"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { ChevronRight, ClipboardCheck, Download, LoaderCircle, Search, TriangleAlert, X } from "lucide-react";
import { toast } from "sonner";
import { cn } from "cn";

import { EmptyState } from "@/components/empty-state";
import { NativeSelect } from "@/components/native-select";
import { Pill } from "@/components/ops-badges";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { callAction } from "@/lib/client-fetch";
import { toCsv } from "@/lib/csv";
import type { ActionResult } from "@/lib/errors";
import {
  ELIGIBILITY_RULE,
  EVAL_PHASE_LABELS,
  finalScore,
  MAX_SCORE,
  MIN_SCORE,
  rankEvaluations,
  RUBRICS,
  SCORE_LABELS,
  TIE_BREAK_ORDER,
  TOTAL_MARKS,
  TRACK_LABELS,
  TRACKS,
  type EvalPhase,
  type Metric,
  type Ranked,
  type Track,
} from "@/lib/evaluation";
import type { Submission } from "@/lib/submissions";
import { saveEvaluationAction } from "@/server/actions/evaluations";
import type { EvaluationRow } from "@/server/services/evaluations";
import { PsButton } from "./ps-dialog";
import { ScoreSheet, type Field, type Saver } from "./score-sheet";

const POLL_MS = 5000;
const SCORES = Array.from({ length: MAX_SCORE - MIN_SCORE + 1 }, (_, i) => MIN_SCORE + i);

type CellKey = `${string}:${Field}`;

const STATUS_FILTERS = {
  all: "Any status",
  todo: "Not scored",
  partial: "Partly scored",
  done: "Fully scored",
  tied: "Tied totals",
} as const;
type StatusFilter = keyof typeof STATUS_FILTERS;

function sheetStatus(rubric: Metric[], r: EvaluationRow) {
  const filled = rubric.filter((m) => r[m.field] != null).length;
  return filled === 0 && !r.track ? "todo" : filled === rubric.length && r.track ? "done" : "partial";
}

function downloadCsv(name: string, rows: (string | number | null)[][]) {
  const url = URL.createObjectURL(new Blob(["﻿" + toCsv(rows)], { type: "text/csv;charset=utf-8" }));
  const a = Object.assign(document.createElement("a"), { href: url, download: name });
  a.click();
  URL.revokeObjectURL(url);
}

function FinalCell({ total, rank }: { total: number | null; rank: Ranked<EvaluationRow> | undefined }) {
  if (total === null) return <span className="text-muted-foreground">—</span>;
  return (
    <>
      <span className="tabular text-lg font-semibold">{total}</span>
      <span className="block text-xs whitespace-nowrap text-muted-foreground">
        #{rank?.rank}
        {rank && rank.tiedWith > 0 && (
          <Pill t="warning" className="ml-1" title={`${rank.tiedWith} other team${rank.tiedWith === 1 ? "" : "s"} have ${total}/${TOTAL_MARKS}`}>
            Tied
          </Pill>
        )}
      </span>
    </>
  );
}

/** Phones and narrower laptops: one card per team; tap to open the score sheet. */
function TeamCard({
  row,
  rubric,
  rank,
  submissions,
  saving,
  onOpen,
}: {
  row: EvaluationRow;
  rubric: Metric[];
  rank: Ranked<EvaluationRow> | undefined;
  submissions: Submission[];
  saving: boolean;
  onOpen: () => void;
}) {
  const total = finalScore(rubric, row);
  const status = sheetStatus(rubric, row);
  return (
    <li className="rounded-xl border bg-card">
      <div className="flex items-start gap-3 p-3">
        <button type="button" onClick={onOpen} className="min-w-0 flex-1 text-left">
          <p className="truncate font-semibold">{row.teamName}</p>
          <p className="truncate text-sm text-muted-foreground">{row.leaderName ?? "No leader"}</p>
          <p className="text-xs text-muted-foreground">
            {row.roomNumber ? `Room ${row.roomNumber}` : "No room"} · {row.present}/{row.size} in
          </p>
        </button>
        <div className="text-right">
          {saving && <LoaderCircle className="mr-1 inline size-3.5 animate-spin text-muted-foreground" aria-label="Saving" />}
          <FinalCell total={total} rank={rank} />
        </div>
        <button type="button" onClick={onOpen} aria-label={`Score ${row.teamName}`} className="-mr-1 self-center rounded-md p-1 text-muted-foreground hover:bg-muted sm:hidden">
          <ChevronRight className="size-5" />
        </button>
      </div>
      <div className="flex flex-wrap items-center gap-2 border-t px-3 py-2">
        <PsButton teamName={row.teamName} submissions={submissions} />
        {row.track ? <Pill t="neutral">{TRACK_LABELS[row.track]}</Pill> : <span className="text-xs whitespace-nowrap text-muted-foreground">No track</span>}
        <div className="ml-auto flex gap-1" aria-label="Scores">
          {rubric.map((m) => (
            <span
              key={m.field}
              title={m.label}
              className={cn(
                "flex size-6 items-center justify-center rounded text-xs font-semibold tabular-nums max-sm:size-5.5",
                row[m.field] == null ? "border border-dashed text-muted-foreground" : "bg-muted",
              )}
            >
              {row[m.field] ?? "·"}
            </span>
          ))}
        </div>
        <Button size="sm" variant={status === "done" ? "outline" : "default"} onClick={onOpen} className="max-sm:hidden">
          {status === "todo" ? "Score" : status === "done" ? "Edit" : "Continue"} <ChevronRight />
        </Button>
      </div>
    </li>
  );
}

export function EvaluationPanel({ phase, initialRows, submissions }: { phase: EvalPhase; initialRows: EvaluationRow[]; submissions: Submission[] }) {
  const rubric = RUBRICS[phase]!;
  const [rows, setRows] = useState(initialRows);
  // Cells being saved: their local value wins over polled data until the save settles.
  const [saving, setSaving] = useState<Map<CellKey, string | number | null>>(new Map());
  const [openTeamId, setOpenTeamId] = useState<string | null>(null);

  const [q, setQ] = useState("");
  const [room, setRoom] = useState("all");
  const [track, setTrack] = useState("all");
  const [status, setStatus] = useState<StatusFilter>("all");
  const [presentOnly, setPresentOnly] = useState(true);
  const [sort, setSort] = useState<"name" | "rank">("name");

  const submissionsByTeam = useMemo(() => {
    const m = new Map<string, Submission[]>();
    for (const s of submissions) if (s.teamId) m.set(s.teamId, [...(m.get(s.teamId) ?? []), s]);
    return m;
  }, [submissions]);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch(`/api/evaluations/${phase}`, { cache: "no-store" });
      const json = (await res.json()) as ActionResult<EvaluationRow[]>;
      if (json.ok) setRows(json.data);
    } catch {
      // Offline for a moment; the next poll catches up.
    }
  }, [phase]);

  useEffect(() => {
    const id = setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, POLL_MS);
    return () => clearInterval(id);
  }, [refresh]);

  // Rows with in-flight edits applied.
  const view = useMemo(
    () =>
      rows.map((r) => {
        let out = r;
        for (const [key, value] of saving) {
          const [teamId, field] = key.split(":") as [string, Field];
          if (teamId === r.teamId) out = { ...out, [field]: value };
        }
        return out;
      }),
    [rows, saving],
  );

  const ranked = useMemo(() => rankEvaluations(rubric, view), [rubric, view]);
  const rankOf = useMemo(() => new Map(ranked.map((r) => [r.teamId, r])), [ranked]);
  const rooms = useMemo(() => [...new Set(rows.map((r) => r.roomNumber).filter((n): n is string => !!n))].sort(), [rows]);

  const save: Saver = async (row, field, value) => {
    const key: CellKey = `${row.teamId}:${field}`;
    setSaving((m) => new Map(m).set(key, value));
    const res = await callAction(() =>
      saveEvaluationAction(
        field === "track"
          ? { phase, teamId: row.teamId, field, value: value as Track | null }
          : { phase, teamId: row.teamId, field, value: value as number | null },
      ),
    );
    if (res.ok) {
      const saved = res.data;
      setRows((all) => all.map((r) => (r.teamId === saved.teamId ? { ...r, ...saved } : r)));
      // Warn as soon as a completed sheet lands on the same total as another team.
      const total = finalScore(rubric, { ...row, ...saved });
      if (total !== null && field !== "track") {
        const others = view.filter((r) => r.teamId !== row.teamId && finalScore(rubric, r) === total).map((r) => r.teamName);
        if (others.length) {
          toast.warning(`${row.teamName} ties with ${others.slice(0, 3).join(", ")}${others.length > 3 ? ` +${others.length - 3}` : ""} at ${total}/${TOTAL_MARKS}`, {
            description: "If they really differ, adjust a metric to separate them.",
          });
        }
      }
    } else {
      toast.error(res.error.message);
    }
    setSaving((m) => {
      const n = new Map(m);
      n.delete(key);
      return n;
    });
  };

  const needle = q.trim().toLowerCase();
  const visible = view
    .filter((r) => {
      if (presentOnly && r.present === 0) return false;
      if (room !== "all" && (r.roomNumber ?? "none") !== room) return false;
      if (track !== "all" && (r.track ?? "none") !== track) return false;
      if (status === "tied") {
        if (!(rankOf.get(r.teamId)?.tiedWith ?? 0)) return false;
      } else if (status !== "all" && sheetStatus(rubric, r) !== status) return false;
      return !needle || r.teamName.toLowerCase().includes(needle) || (r.leaderName ?? "").toLowerCase().includes(needle) || r.teamCode.toLowerCase().includes(needle);
    })
    .sort((a, b) => {
      if (sort === "rank") {
        const ra = rankOf.get(a.teamId)?.rank ?? Infinity;
        const rb = rankOf.get(b.teamId)?.rank ?? Infinity;
        if (ra !== rb) return ra - rb;
      }
      return a.teamName.localeCompare(b.teamName);
    });

  const pool = view.filter((r) => !presentOnly || r.present > 0);
  const done = pool.filter((r) => sheetStatus(rubric, r) === "done").length;
  const tiedTeams = ranked.filter((r) => r.tiedWith > 0).length;
  const filtered = needle || room !== "all" || track !== "all" || status !== "all";
  const isRowSaving = (teamId: string) => [...saving.keys()].some((k) => k.startsWith(`${teamId}:`));

  // Score-sheet navigation follows the list as currently filtered and sorted.
  const openRow = openTeamId ? (view.find((r) => r.teamId === openTeamId) ?? null) : null;
  const order = visible.map((r) => r.teamId);
  const at = openTeamId ? order.indexOf(openTeamId) : -1;
  const prevId = at > 0 ? order[at - 1] : null;
  const nextId = at >= 0 ? (order[at + 1] ?? null) : (order[0] ?? null);
  const nextUnscoredId = (() => {
    for (let i = 1; i <= order.length; i++) {
      const id = order[(Math.max(at, -1) + i) % order.length];
      if (id !== openTeamId && sheetStatus(rubric, view.find((r) => r.teamId === id)!) !== "done") return id;
    }
    return null;
  })();

  const exportCsv = () =>
    downloadCsv(`${phase}-evaluation.csv`, [
      ["Rank", "Team", "Team code", "Leader", "Room", "Track", "Idea title", ...rubric.map((m) => `${m.label} (/${MAX_SCORE})`), `Final (/${TOTAL_MARKS})`, "Last scored by", "Last scored at"],
      ...[...view]
        .sort((a, b) => (rankOf.get(a.teamId)?.rank ?? Infinity) - (rankOf.get(b.teamId)?.rank ?? Infinity) || a.teamName.localeCompare(b.teamName))
        .map((r) => [
          rankOf.get(r.teamId)?.rank ?? "",
          r.teamName,
          r.teamCode,
          r.leaderName ?? "",
          r.roomNumber ?? "",
          r.track ? TRACK_LABELS[r.track] : "",
          submissionsByTeam.get(r.teamId)?.at(-1)?.title ?? "",
          ...rubric.map((m) => r[m.field]),
          finalScore(rubric, r),
          r.updatedBy ?? "",
          r.updatedAt ?? "",
        ]),
    ]);

  return (
    <div className="flex flex-col gap-4 sm:gap-5">
      <PageHeader
        title={EVAL_PHASE_LABELS[phase]}
        description={`Each metric ${MIN_SCORE}–${MAX_SCORE} · final out of ${TOTAL_MARKS}`}
        actions={
          <Button variant="outline" onClick={exportCsv}>
            <Download /> <span className="hidden sm:inline">Download</span> CSV
          </Button>
        }
      />

      <div className="rounded-xl border bg-card px-4 py-3">
        <div className="flex items-baseline justify-between gap-2 text-sm">
          <span className="font-semibold">
            {done} of {pool.length} teams fully scored
          </span>
          {tiedTeams > 0 && (
            <button type="button" className="text-xs font-medium text-warning-foreground hover:underline" onClick={() => setStatus("tied")}>
              {tiedTeams} teams share a total
            </button>
          )}
        </div>
        <div className="mt-2 h-2 overflow-hidden rounded-full bg-muted" role="progressbar" aria-valuemin={0} aria-valuemax={pool.length} aria-valuenow={done} aria-label="Teams scored">
          <div className="h-full rounded-full bg-success transition-[width]" style={{ width: `${pool.length ? (done / pool.length) * 100 : 0}%` }} />
        </div>
      </div>

      <div className="flex gap-2 rounded-xl border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm">
        <TriangleAlert className="mt-0.5 size-4 shrink-0 text-destructive" aria-hidden />
        <p>
          <span className="font-semibold">Eligibility rule: </span>
          <span className="sm:hidden">no open-source AI or open-weight model at its core means the team is eliminated.</span>
          <span className="max-sm:hidden">{ELIGIBILITY_RULE}</span>
        </p>
      </div>

      <details className="rounded-xl border bg-card px-4 py-3 text-sm">
        <summary className="cursor-pointer font-semibold">
          Rubric<span className="font-normal text-muted-foreground sm:hidden"> · {rubric.length} metrics, {rubric[0].weight}% each</span>
          <span className="max-sm:hidden"> · {rubric.map((m) => `${m.label} ${m.weight}%`).join(" · ")}</span>
        </summary>
        <div className="mt-3 flex flex-col gap-3 md:hidden">
          {rubric.map((m) => (
            <div key={m.field}>
              <p className="font-semibold">
                {m.label} <span className="font-normal text-muted-foreground">({m.weight}%)</span>
              </p>
              <ol className="mt-1 flex flex-col gap-1 text-xs text-muted-foreground">
                {m.levels.map((l, i) => (
                  <li key={i}>
                    <span className="font-semibold text-foreground">
                      {i + 1} {SCORE_LABELS[i]}:
                    </span>{" "}
                    {l}
                  </li>
                ))}
              </ol>
            </div>
          ))}
        </div>
        <div className="mt-3 hidden overflow-x-auto md:block">
          <table className="w-full min-w-[56rem] text-xs">
            <thead className="text-muted-foreground">
              <tr>
                <th className="py-1 pr-3 text-left font-medium">Metric</th>
                {SCORE_LABELS.map((l, i) => (
                  <th key={l} className="px-2 py-1 text-left font-medium">
                    {i + 1} — {l}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y align-top">
              {rubric.map((m) => (
                <tr key={m.field}>
                  <td className="py-2 pr-3 font-semibold">
                    {m.label} <span className="font-normal text-muted-foreground">({m.weight}%)</span>
                  </td>
                  {m.levels.map((l, i) => (
                    <td key={i} className="px-2 py-2 text-muted-foreground">
                      {l}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>

      <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
        <div className="sticky top-14 z-20 -mx-4 bg-background/95 px-4 py-1 backdrop-blur sm:static sm:mx-0 sm:min-w-56 sm:flex-1 sm:bg-transparent sm:p-0 lg:top-0">
          <div className="relative">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search team or leader" className="h-10 pl-9" aria-label="Search teams" />
          </div>
        </div>
        <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap">
          <NativeSelect value={room} onChange={(e) => setRoom(e.target.value)} aria-label="Room" className="sm:w-36">
            <option value="all">All rooms</option>
            {rooms.map((n) => (
              <option key={n} value={n}>
                Room {n}
              </option>
            ))}
            <option value="none">No room</option>
          </NativeSelect>
          <NativeSelect value={track} onChange={(e) => setTrack(e.target.value)} aria-label="Track filter" className="sm:w-40">
            <option value="all">Any track</option>
            {TRACKS.map((t) => (
              <option key={t} value={t}>
                {TRACK_LABELS[t]}
              </option>
            ))}
            <option value="none">No track yet</option>
          </NativeSelect>
          <NativeSelect value={status} onChange={(e) => setStatus(e.target.value as StatusFilter)} aria-label="Scoring status" className="sm:w-40">
            {Object.entries(STATUS_FILTERS).map(([v, l]) => (
              <option key={v} value={v}>
                {l}
                {v === "tied" && tiedTeams ? ` (${tiedTeams})` : ""}
              </option>
            ))}
          </NativeSelect>
          <NativeSelect value={sort} onChange={(e) => setSort(e.target.value as "name" | "rank")} aria-label="Sort" className="sm:w-40">
            <option value="name">Sort: team name</option>
            <option value="rank">Sort: ranking</option>
          </NativeSelect>
        </div>
        <div className="flex items-center gap-2">
          <label className="flex h-10 flex-1 items-center gap-2 rounded-lg border px-3 text-sm sm:flex-none">
            <input type="checkbox" checked={presentOnly} onChange={(e) => setPresentOnly(e.target.checked)} className="size-4 accent-primary" />
            Checked-in teams only
          </label>
          {filtered && (
            <Button
              variant="ghost"
              onClick={() => {
                setQ("");
                setRoom("all");
                setTrack("all");
                setStatus("all");
              }}
            >
              <X /> Clear
            </Button>
          )}
        </div>
      </div>

      {visible.length === 0 ? (
        <EmptyState icon={ClipboardCheck} title="No teams match">
          Try another search or clear the filters.
        </EmptyState>
      ) : (
        <>
          <ul className="flex flex-col gap-2 xl:hidden">
            {visible.map((r) => (
              <TeamCard
                key={r.teamId}
                row={r}
                rubric={rubric}
                rank={rankOf.get(r.teamId)}
                submissions={submissionsByTeam.get(r.teamId) ?? []}
                saving={isRowSaving(r.teamId)}
                onOpen={() => setOpenTeamId(r.teamId)}
              />
            ))}
          </ul>

          <div className="hidden overflow-x-auto rounded-xl border bg-card xl:block">
            <table className="w-full text-sm">
              <thead className="border-b bg-muted/40 text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 text-left font-medium">Team name</th>
                  <th className="px-3 py-2 text-left font-medium">Team leader</th>
                  <th className="px-2 py-2 text-left font-medium">PS</th>
                  <th className="px-2 py-2 text-left font-medium">Track</th>
                  {rubric.map((m) => (
                    <th key={m.field} className="px-1.5 py-2 text-left font-medium" title={`${m.label}: ${m.weight}% of the total`}>
                      <span className="block max-w-24 leading-tight">{m.label}</span>
                      <span className="text-xs font-normal">/{MAX_SCORE}</span>
                    </th>
                  ))}
                  <th className="px-3 py-2 text-right font-medium">
                    Final <span className="text-xs font-normal">/{TOTAL_MARKS}</span>
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {visible.map((r) => {
                  const busy = (f: Field) => saving.has(`${r.teamId}:${f}`);
                  return (
                    <tr key={r.teamId} className="hover:bg-muted/30">
                      <td className="max-w-52 px-3 py-2">
                        <button type="button" className="block max-w-full truncate text-left font-semibold text-primary hover:underline" onClick={() => setOpenTeamId(r.teamId)}>
                          {r.teamName}
                        </button>
                        <span className="text-xs text-muted-foreground">
                          {r.roomNumber ? `Room ${r.roomNumber}` : "No room"} · {r.present}/{r.size} in
                        </span>
                      </td>
                      <td className="max-w-40 truncate px-3 py-2">{r.leaderName ?? <span className="text-muted-foreground">—</span>}</td>
                      <td className="px-2 py-2">
                        <PsButton teamName={r.teamName} submissions={submissionsByTeam.get(r.teamId) ?? []} />
                      </td>
                      <td className="px-2 py-2">
                        <NativeSelect
                          value={r.track ?? ""}
                          aria-label={`Track for ${r.teamName}`}
                          className={cn("w-34 [&_select]:h-9", !r.track && "[&_select]:text-muted-foreground")}
                          onChange={(e) => void save(r, "track", (e.target.value || null) as Track | null)}
                          disabled={busy("track")}
                        >
                          <option value="">Choose…</option>
                          {TRACKS.map((t) => (
                            <option key={t} value={t}>
                              {TRACK_LABELS[t]}
                            </option>
                          ))}
                        </NativeSelect>
                      </td>
                      {rubric.map((m) => {
                        const v = r[m.field];
                        return (
                          <td key={m.field} className="px-1.5 py-2 align-top">
                            <NativeSelect
                              value={v == null ? "" : String(v)}
                              aria-label={`${m.label} for ${r.teamName}`}
                              title={v == null ? m.label : `${v} — ${SCORE_LABELS[v - 1]}: ${m.levels[v - 1]}`}
                              className={cn("w-16 [&_select]:h-9 [&_select]:tabular-nums", v == null && "[&_select]:text-muted-foreground")}
                              onChange={(e) => void save(r, m.field, e.target.value ? Number(e.target.value) : null)}
                              disabled={busy(m.field)}
                            >
                              <option value="">–</option>
                              {SCORES.map((s) => (
                                <option key={s} value={s}>
                                  {s}
                                </option>
                              ))}
                            </NativeSelect>
                            <span className="mt-0.5 block h-4 text-[11px] leading-4 whitespace-nowrap text-muted-foreground">{v != null && SCORE_LABELS[v - 1]}</span>
                          </td>
                        );
                      })}
                      <td className="px-3 py-2 text-right">
                        {isRowSaving(r.teamId) && <LoaderCircle className="mr-1 inline size-3.5 animate-spin text-muted-foreground" aria-label="Saving" />}
                        <FinalCell total={finalScore(rubric, r)} rank={rankOf.get(r.teamId)} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
      <p className="text-xs text-muted-foreground">
        Each metric is worth {rubric[0].weight}% (1 point = {(rubric[0].weight * TOTAL_MARKS) / (MAX_SCORE * 100)} marks). Changes save instantly and other judges see them within seconds.
        Equal totals are ranked by {TIE_BREAK_ORDER.map((f) => rubric.find((m) => m.field === f)!.label).join(", then ")}; teams marked <em>Tied</em> share a total, so
        adjust a metric if they really differ.
      </p>

      <ScoreSheet
        row={openRow}
        rank={openTeamId ? rankOf.get(openTeamId) : undefined}
        rubric={rubric}
        submissions={openTeamId ? (submissionsByTeam.get(openTeamId) ?? []) : []}
        isSaving={(f) => !!openTeamId && saving.has(`${openTeamId}:${f}`)}
        onSave={save}
        onClose={() => setOpenTeamId(null)}
        onPrev={prevId ? () => setOpenTeamId(prevId) : null}
        onNext={nextId ? () => setOpenTeamId(nextId) : null}
        onNextUnscored={nextUnscoredId ? () => setOpenTeamId(nextUnscoredId) : null}
      />
    </div>
  );
}

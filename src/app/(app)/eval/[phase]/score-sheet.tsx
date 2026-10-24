"use client";

import { ChevronLeft, ChevronRight, SkipForward, X } from "lucide-react";
import { cn } from "cn";

import { Pill } from "@/components/ops-badges";
import { Button } from "@/components/ui/button";
import { Sheet, SheetClose, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { finalScore, MAX_SCORE, MIN_SCORE, SCORE_LABELS, TOTAL_MARKS, TRACK_LABELS, TRACKS, type Metric, type Ranked, type ScoreField, type Track } from "@/lib/evaluation";
import type { Submission } from "@/lib/submissions";
import type { EvaluationRow } from "@/server/services/evaluations";
import { PsButton } from "./ps-dialog";

export type Field = ScoreField | "track";
export type Saver = (row: EvaluationRow, field: Field, value: string | number | null) => Promise<void>;

const SCORES = Array.from({ length: MAX_SCORE - MIN_SCORE + 1 }, (_, i) => MIN_SCORE + i);

/** Big tap targets, one per score; the chosen level's rubric text shows underneath. */
function MetricInput({ metric, value, busy, onChange }: { metric: Metric; value: number | null; busy: boolean; onChange: (v: number | null) => void }) {
  return (
    <fieldset className="rounded-xl border p-3">
      <legend className="sr-only">{metric.label}</legend>
      <div className="mb-2 flex items-baseline justify-between gap-2">
        <p className="text-sm font-semibold">
          {metric.label} <span className="font-normal text-muted-foreground">· {metric.weight}%</span>
        </p>
        {value != null && (
          <button type="button" className="text-xs text-muted-foreground hover:text-foreground hover:underline" onClick={() => onChange(null)} disabled={busy}>
            Clear
          </button>
        )}
      </div>
      <div className="grid grid-cols-5 gap-1.5" role="radiogroup" aria-label={metric.label}>
        {SCORES.map((s) => {
          const active = value === s;
          return (
            <button
              key={s}
              type="button"
              role="radio"
              aria-checked={active}
              aria-label={`${s}, ${SCORE_LABELS[s - 1]}`}
              disabled={busy}
              onClick={() => onChange(s)}
              className={cn(
                "flex h-12 flex-col items-center justify-center rounded-lg border text-base font-semibold tabular-nums transition-colors disabled:opacity-60",
                active ? "border-primary bg-primary text-primary-foreground" : "bg-background hover:bg-muted",
              )}
            >
              {s}
              <span className={cn("hidden text-[10px] leading-none font-normal sm:block", active ? "text-primary-foreground/80" : "text-muted-foreground")}>
                {SCORE_LABELS[s - 1]}
              </span>
            </button>
          );
        })}
      </div>
      <p className="mt-2 min-h-10 text-xs leading-relaxed text-muted-foreground">
        {value != null ? (
          <>
            <span className="font-semibold text-foreground">{SCORE_LABELS[value - 1]}:</span> {metric.levels[value - 1]}
          </>
        ) : (
          "Not scored yet. Tap a score; each level's rubric description appears here."
        )}
      </p>
    </fieldset>
  );
}

export function ScoreSheet({
  row,
  rank,
  rubric,
  submissions,
  isSaving,
  onSave,
  onClose,
  onPrev,
  onNext,
  onNextUnscored,
}: {
  row: EvaluationRow | null;
  rank: Ranked<EvaluationRow> | undefined;
  rubric: Metric[];
  submissions: Submission[];
  isSaving: (field: Field) => boolean;
  onSave: Saver;
  onClose: () => void;
  onPrev: (() => void) | null;
  onNext: (() => void) | null;
  onNextUnscored: (() => void) | null;
}) {
  const total = row ? finalScore(rubric, row) : null;
  return (
    <Sheet open={row !== null} onOpenChange={(o) => !o && onClose()}>
      <SheetContent side="right" showCloseButton={false} className="w-full! max-w-none! gap-0 overflow-y-auto p-0 sm:max-w-xl!">
        {row && (
          <>
            <SheetHeader className="sticky top-0 z-10 border-b bg-background/95 px-4 py-3 backdrop-blur sm:px-5">
              <div className="flex items-start gap-3">
                <div className="min-w-0 flex-1">
                  <SheetTitle className="truncate text-lg">{row.teamName}</SheetTitle>
                  <SheetDescription className="truncate">
                    {row.leaderName ?? "No leader"} · {row.roomNumber ? `Room ${row.roomNumber}` : "No room"} · {row.present}/{row.size} checked in
                  </SheetDescription>
                </div>
                <div className="text-right">
                  <p className="tabular text-2xl leading-none font-semibold">
                    {total ?? "—"}
                    <span className="text-sm font-normal text-muted-foreground">/{TOTAL_MARKS}</span>
                  </p>
                  {rank && (
                    <p className="mt-1 text-xs text-muted-foreground">
                      #{rank.rank}
                      {rank.tiedWith > 0 && (
                        <Pill t="warning" className="ml-1">
                          Tied
                        </Pill>
                      )}
                    </p>
                  )}
                </div>
                <SheetClose render={<Button variant="ghost" size="icon" className="-mr-2" aria-label="Close" />}>
                  <X />
                </SheetClose>
              </div>
            </SheetHeader>

            <div className="flex flex-col gap-3 px-4 py-4 sm:px-5">
              <div className="flex items-center justify-between gap-3">
                <div className="grid flex-1 grid-cols-2 gap-1.5" role="radiogroup" aria-label="Track">
                  {TRACKS.map((t) => {
                    const active = row.track === t;
                    return (
                      <button
                        key={t}
                        type="button"
                        role="radio"
                        aria-checked={active}
                        disabled={isSaving("track")}
                        onClick={() => void onSave(row, "track", active ? null : (t as Track))}
                        className={cn(
                          "h-11 rounded-lg border text-sm font-semibold transition-colors disabled:opacity-60",
                          active ? "border-primary bg-primary text-primary-foreground" : "bg-background hover:bg-muted",
                        )}
                      >
                        {TRACK_LABELS[t]}
                      </button>
                    );
                  })}
                </div>
                <PsButton teamName={row.teamName} submissions={submissions} size="default" />
              </div>
              {!row.track && <p className="-mt-1 text-xs text-muted-foreground">Choose the team&apos;s track.</p>}

              {rubric.map((m) => (
                <MetricInput key={m.field} metric={m} value={row[m.field]} busy={isSaving(m.field)} onChange={(v) => void onSave(row, m.field, v)} />
              ))}
            </div>

            <div className="sticky bottom-0 flex items-center gap-2 border-t bg-background/95 px-4 py-3 backdrop-blur sm:px-5">
              <Button variant="outline" onClick={onPrev ?? undefined} disabled={!onPrev} aria-label="Previous team">
                <ChevronLeft /> <span className="hidden sm:inline">Previous</span>
              </Button>
              <Button variant="outline" className="flex-1" onClick={onNextUnscored ?? undefined} disabled={!onNextUnscored}>
                <SkipForward /> Next unscored
              </Button>
              <Button onClick={onNext ?? undefined} disabled={!onNext} aria-label="Next team">
                <span className="hidden sm:inline">Next</span> <ChevronRight />
              </Button>
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}

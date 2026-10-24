"use client";

import { useState } from "react";
import { FileText, X } from "lucide-react";

import { GitHubIcon } from "@/components/github-icon";
import { Pill } from "@/components/ops-badges";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { statementsIn, type ProblemStatement } from "@/lib/problem-statements";
import type { Submission } from "@/lib/submissions";

function Line({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <p className="text-[15px] leading-relaxed sm:text-base">
      <span className="font-bold">{label}:</span> {children}
    </p>
  );
}

/** Laid out like the problem-statement slides: Title, Problem Statement, then Who it helps | What to build. */
function Statement({ ps }: { ps: ProblemStatement }) {
  return (
    <section className="flex flex-col gap-4">
      <p className="text-xs font-semibold text-muted-foreground">Problem Statement #{ps.number}</p>
      <Line label="Title">{ps.title}</Line>
      <Line label="Problem Statement">{ps.problem}</Line>
      <div className="grid gap-4 text-[15px] sm:grid-cols-2 sm:gap-6 sm:text-base">
        <div>
          <p className="font-bold">Who it helps:</p>
          <p className="mt-1.5 leading-relaxed">{ps.whoItHelps}</p>
        </div>
        <div>
          <p className="font-bold">What to build:</p>
          <p className="mt-1.5 leading-relaxed">{ps.whatToBuild}</p>
        </div>
      </div>
    </section>
  );
}

/** A team's own idea, in the same layout. */
function OwnIdea({ s }: { s: Submission }) {
  const closest = s.psMatch === "partial" ? statementsIn(s.matchedStatement) : [];
  return (
    <section className="flex flex-col gap-4">
      <p className="text-xs font-semibold text-muted-foreground">Team&apos;s own idea</p>
      <Line label="Title">{s.title ?? "—"}</Line>
      <Line label="Problem Statement">{s.description ?? "—"}</Line>
      {closest.length > 0 && (
        <p className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <Pill t="warning">Partly matches</Pill>
          Closest: {closest.map((p) => `#${p.number} ${p.title}`).join("; ")}
        </p>
      )}
    </section>
  );
}

/** Matched teams show the official statement(s); everyone else shows their own response. */
function Response({ s }: { s: Submission }) {
  const statements = s.psMatch === "yes" ? statementsIn(s.matchedStatement) : [];
  if (statements.length === 0) return <OwnIdea s={s} />;
  return (
    <div className="flex flex-col gap-6">
      {statements.map((ps, i) => (
        <div key={ps.number} className={i > 0 ? "border-t pt-6" : undefined}>
          <Statement ps={ps} />
        </div>
      ))}
    </div>
  );
}

/** "PS" button: the team's problem statement, with the repo behind the GitHub button. */
export function PsButton({ teamName, submissions, size = "sm" }: { teamName: string; submissions: Submission[]; size?: "sm" | "default" }) {
  const [open, setOpen] = useState(false);
  if (submissions.length === 0) {
    return (
      <Button variant="outline" size={size} disabled title="This team hasn't submitted the problem-statement form">
        PS
      </Button>
    );
  }
  // Latest response first: teams that resubmitted usually corrected something.
  const ordered = [...submissions].reverse();
  const latest = ordered[0];
  return (
    <>
      <Button
        variant="outline"
        size={size}
        onClick={(e) => {
          e.stopPropagation();
          setOpen(true);
        }}
        aria-label={`Problem statement for ${teamName}`}
      >
        <FileText /> PS
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent
          showCloseButton={false}
          className="flex max-h-[90dvh] w-[calc(100%-1.5rem)] flex-col gap-0 p-0 sm:max-w-2xl"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="flex items-center gap-2 border-b px-4 py-3 sm:px-5">
            <div className="min-w-0 flex-1">
              <DialogTitle className="truncate text-sm font-semibold">{teamName}</DialogTitle>
              <DialogDescription className="truncate text-xs">
                {latest.leaderName ?? "Problem statement"}
                {latest.psMatch === "yes" && latest.title && ` · Idea: ${latest.title}`}
              </DialogDescription>
            </div>
            {latest.repoUrl && (
              <a
                href={latest.repoUrl}
                target="_blank"
                rel="noopener noreferrer"
                title="Open the GitHub repository"
                aria-label="Open the GitHub repository"
                className="inline-flex size-10 shrink-0 items-center justify-center rounded-lg border bg-background hover:bg-muted"
              >
                <GitHubIcon className="size-5" />
              </a>
            )}
            <DialogClose render={<Button variant="ghost" size="icon" className="size-10" aria-label="Close" />}>
              <X />
            </DialogClose>
          </div>
          <div className="flex flex-col gap-6 overflow-y-auto px-4 py-5 sm:px-5">
            {ordered.map((s, i) => (
              <div key={s.id} className={i > 0 ? "border-t pt-6" : undefined}>
                {ordered.length > 1 && (
                  <p className="mb-3 text-xs font-semibold text-muted-foreground uppercase">
                    {i === 0 ? "Latest response" : "Earlier response"}
                    {s.submittedAt && ` · ${s.submittedAt}`}
                  </p>
                )}
                <Response s={s} />
              </div>
            ))}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

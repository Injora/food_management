import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { getDb } from "@/db";
import { EVAL_PHASE_LABELS, OPEN_EVAL_PHASES, RUBRICS, type EvalPhase } from "@/lib/evaluation";
import { requireActor } from "@/server/auth/current";
import { can } from "@/server/auth/permissions";
import { listEvaluations } from "@/server/services/evaluations";
import { listSubmissions } from "@/server/services/submissions";
import { EvaluationPanel } from "./evaluation-panel";

export async function generateMetadata({ params }: PageProps<"/eval/[phase]">): Promise<Metadata> {
  const { phase } = await params;
  return { title: EVAL_PHASE_LABELS[phase as EvalPhase] ?? "Evaluation" };
}

export default async function EvaluationPage({ params }: PageProps<"/eval/[phase]">) {
  const actor = await requireActor();
  const { phase } = await params;
  // Not "forbidden": to anyone but a super admin, judging doesn't exist.
  if (!can(actor, "eval:score") || !OPEN_EVAL_PHASES.includes(phase as EvalPhase) || !RUBRICS[phase as EvalPhase]) notFound();
  const db = await getDb();
  const [rows, submissions] = await Promise.all([listEvaluations(db, actor, phase), listSubmissions(db, actor)]);
  return <EvaluationPanel phase={phase as EvalPhase} initialRows={rows} submissions={submissions} />;
}

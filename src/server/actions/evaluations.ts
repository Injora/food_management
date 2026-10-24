"use server";

import type { ScoreField, Track } from "@/lib/evaluation";
import { runAction } from "@/server/action-result";
import { saveEvaluation } from "@/server/services/evaluations";

export async function saveEvaluationAction(
  input: { phase: string; teamId: string } & ({ field: "track"; value: Track | null } | { field: ScoreField; value: number | null }),
) {
  return runAction((db, actor) => saveEvaluation(db, actor, input));
}

/**
 * Hackathon judging. Each phase has its own rubric: metrics scored 1–5 and
 * weighted to a whole-number total out of 50. Pure, shared by the server and
 * the panel, and imported by the schema (so no "@/" imports here).
 */

export const EVAL_PHASES = ["mid", "final"] as const;
export type EvalPhase = (typeof EVAL_PHASES)[number];
/** Phases that are open in the panel. The final rubric is added later. */
export const OPEN_EVAL_PHASES: readonly EvalPhase[] = ["mid"];
export const EVAL_PHASE_LABELS: Record<EvalPhase, string> = { mid: "Mid evaluation", final: "Final evaluation" };

export const TRACKS = ["gemma", "open_source"] as const;
export type Track = (typeof TRACKS)[number];
export const TRACK_LABELS: Record<Track, string> = { gemma: "Gemma", open_source: "Open-Source" };

/** Database columns for the five scores, shared by every phase. */
export const SCORE_FIELDS = ["score1", "score2", "score3", "score4", "score5"] as const;
export type ScoreField = (typeof SCORE_FIELDS)[number];

/** Rubric column headings for scores 1–5. */
export const SCORE_LABELS = ["Poor", "Below Average", "Good", "Very Good", "Excellent"] as const;

export const MIN_SCORE = 1;
export const MAX_SCORE = 5;
export const TOTAL_MARKS = 50;

export type Metric = {
  field: ScoreField;
  label: string;
  /** Percent of the total; a rubric's weights add up to 100. */
  weight: number;
  /** What each score from 1 to 5 means, from the rubric. */
  levels: [string, string, string, string, string];
};

/** "Hacktoberfest Hack Day: Mid Evaluation Rubric (after 5 hours)". */
export const MID_RUBRIC: Metric[] = [
  {
    field: "score1",
    label: "Clarity of Idea and Scope",
    weight: 20,
    levels: [
      "Idea is unclear or the team cannot explain it. No defined user or MVP.",
      "Idea is understandable but vague. User or scope is unclear, or the scope is far too big for the time left.",
      "Idea and target user are clearly stated. The MVP is defined and mostly realistic for the remaining time.",
      "Specific problem and user. Focused MVP with a sensible plan and a fallback if time runs short.",
      "Exceptionally clear problem, user and MVP. Realistic plan for the remaining hours, with clear priorities and a fallback.",
    ],
  },
  {
    field: "score2",
    label: "Structure",
    weight: 20,
    levels: [
      "No clear plan or design. The team cannot say how the project is organized or what its main parts are.",
      "Rough idea of the parts, but the design is unclear. The repo has little structure and the work is not split into tasks.",
      "Main parts and flow are defined (for example input, model, output). A repo exists with a basic structure and tasks are split among members.",
      "Clear architecture with well-defined components. Organized repo with a README and a task plan with owners.",
      "Well-thought-out design with clear components, data flow and model choice. Clean repo, README started, and a realistic plan with owners and priorities.",
    ],
  },
  {
    field: "score3",
    label: "Progress",
    weight: 20,
    levels: [
      "Only planning or ideas. Nothing built or running yet.",
      "Setup started, but little works. Major parts not started.",
      "Setup done and some parts working. The first input-to-output path is partly working.",
      "Core feature working end to end, even if rough. Clear next steps for the remaining time.",
      "Core feature working well and testing started. Team is ahead of its own plan with next steps ready.",
    ],
  },
  {
    field: "score4",
    label: "Understanding of Implementation",
    weight: 20,
    levels: [
      "Team cannot explain how the project works or where the AI model is used.",
      "Can describe the idea but not the flow. Unsure which model is used or why.",
      "Can explain the main flow and name the open-source or open-weight model being used.",
      "Explains the flow, the model choice and key decisions clearly. Can point to the code where the model is used.",
      "Every member can explain the flow, the model choice, the trade-offs and what did not work. Clear command of how it is built.",
    ],
  },
  {
    field: "score5",
    label: "Teamwork",
    weight: 20,
    levels: [
      "One person is doing most of the work. Roles are unclear.",
      "Some roles defined, but contributions are uneven. Little collaboration.",
      "Roles are defined and most members are contributing.",
      "Clear roles and good collaboration. Everyone can say what they worked on.",
      "Strong collaboration and shared ownership. Every member contributes and is learning something new.",
    ],
  },
];

export const RUBRICS: Partial<Record<EvalPhase, Metric[]>> = { mid: MID_RUBRIC };

export const ELIGIBILITY_RULE =
  "A team not using an open-source AI or open-weight model as an important part of its project is eliminated, whatever its scores. Ask the team which open-source AI or open-weight model they are using.";

export type Scores = Partial<Record<ScoreField, number | null>>;

/**
 * Weighted total out of 50, or null until every metric is scored. Each point
 * is worth weight% × 50 / 5, so with 20% weights a point is exactly 2 marks
 * and the total is always a whole number.
 */
export function finalScore(rubric: Metric[], scores: Scores): number | null {
  let total = 0;
  for (const m of rubric) {
    const s = scores[m.field];
    if (s == null) return null;
    total += (s * m.weight * TOTAL_MARKS) / (MAX_SCORE * 100);
  }
  return Math.round(total);
}

/**
 * Order used to separate equal totals, most important first: what's working,
 * then whether the team understands it, then the rest of the rubric.
 */
export const TIE_BREAK_ORDER: ScoreField[] = ["score3", "score4", "score2", "score1", "score5"];

export type Ranked<T> = T & { final: number; rank: number; tiedWith: number };

/**
 * Ranks fully scored entries by total, then by the tie-break metrics. Entries
 * equal on everything share a rank, and `tiedWith` counts the others sharing
 * their total so the panel can flag ties for the judges to resolve.
 */
export function rankEvaluations<T extends Scores>(rubric: Metric[], entries: T[]): Ranked<T>[] {
  const scored = entries
    .map((e) => ({ e, final: finalScore(rubric, e) }))
    .filter((x): x is { e: T; final: number } => x.final !== null);
  const compare = (a: { e: T; final: number }, b: { e: T; final: number }) => {
    if (b.final !== a.final) return b.final - a.final;
    for (const f of TIE_BREAK_ORDER) {
      const d = (b.e[f] ?? 0) - (a.e[f] ?? 0);
      if (d !== 0) return d;
    }
    return 0;
  };
  scored.sort(compare);
  const sameTotal = new Map<number, number>();
  for (const x of scored) sameTotal.set(x.final, (sameTotal.get(x.final) ?? 0) + 1);
  const out: Ranked<T>[] = [];
  scored.forEach((x, i) => {
    const prev = out[i - 1];
    const rank = prev && compare(scored[i - 1], x) === 0 ? prev.rank : i + 1;
    out.push({ ...x.e, final: x.final, rank, tiedWith: sameTotal.get(x.final)! - 1 });
  });
  return out;
}

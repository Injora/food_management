/**
 * Hackathon judging. Each phase has its own rubric: weighted metrics scored on
 * the rubric's scale (mid 1–5, final 1–10) and added up to a whole-number
 * total. Pure, shared by the server and the panel, and imported by the schema
 * (so no "@/" imports here).
 */

export const EVAL_PHASES = ["mid", "final"] as const;
export type EvalPhase = (typeof EVAL_PHASES)[number];
/** Phases that are open in the panel. */
export const OPEN_EVAL_PHASES: readonly EvalPhase[] = ["mid", "final"];
export const EVAL_PHASE_LABELS: Record<EvalPhase, string> = { mid: "Mid evaluation", final: "Final evaluation" };

export const TRACKS = ["gemma", "open_source"] as const;
export type Track = (typeof TRACKS)[number];
export const TRACK_LABELS: Record<Track, string> = { gemma: "Gemma", open_source: "Open-Source" };

/** Database columns for the scores, shared by every phase (mid uses the first five). */
export const SCORE_FIELDS = ["score1", "score2", "score3", "score4", "score5", "score6"] as const;
export type ScoreField = (typeof SCORE_FIELDS)[number];

/** The rubrics' five level headings, from worst to best. */
export const SCORE_LABELS = ["Poor", "Below Average", "Good", "Very Good", "Excellent"] as const;

export const MIN_SCORE = 1;
/** Highest score any rubric allows; the database checks against it. */
export const MAX_SCORE_ANY = 10;

export type Metric = {
  field: ScoreField;
  label: string;
  /** Percent of the total; a rubric's weights add up to 100. */
  weight: number;
  /** What each of the five levels means, from the rubric. */
  levels: [string, string, string, string, string];
};

export type Rubric = {
  metrics: Metric[];
  /** Scores run from MIN_SCORE to this. */
  maxScore: number;
  /** The weighted total is out of this. */
  totalMarks: number;
  /** Metrics that separate equal totals, most important first. */
  tieBreak: ScoreField[];
  eligibility: string;
  /** The eligibility rule in a phrase, for phones. */
  eligibilityShort: string;
};

/**
 * Which of the five rubric levels a score falls in. On the 1–10 scale each
 * level covers two scores: 1–2 Poor, 3–4 Below Average … 9–10 Excellent.
 */
export function levelIndex(rubric: Rubric, score: number): number {
  return Math.min(SCORE_LABELS.length, Math.ceil((score * SCORE_LABELS.length) / rubric.maxScore)) - 1;
}

/** "Hacktoberfest Hack Day: Mid Evaluation Rubric (after 5 hours)". */
const MID_METRICS: Metric[] = [
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

export const MID_RUBRIC: Rubric = {
  metrics: MID_METRICS,
  maxScore: 5,
  totalMarks: 50,
  // What's working, then whether the team understands it, then the rest.
  tieBreak: ["score3", "score4", "score2", "score1", "score5"],
  eligibility:
    "A team not using an open-source AI or open-weight model as an important part of its project is eliminated, whatever its scores. Ask the team which open-source AI or open-weight model they are using.",
  eligibilityShort: "no open-source AI or open-weight model at its core means the team is eliminated.",
};

/** "Hacktoberfest Hack Day: Final Evaluation Rubric (8 minutes per team)". */
export const FINAL_RUBRIC: Rubric = {
  metrics: [
    {
      field: "score1",
      label: "Technology and Open-Source AI Use",
      weight: 25,
      levels: [
        "AI is barely used or added only for show. Basic technical work.",
        "AI is used in a minor way. Simple setup with major technical limitations.",
        "One open-source or open-weight model does the core task. Reasonable technical choices.",
        "Strong technical choices. The model is well integrated, with extra parts such as retrieval, validation or a well-built interface.",
        "Sophisticated, well-justified use of open AI, with a clever technique or many parts working together. Team names the model and license and explains the choice.",
      ],
    },
    {
      field: "score2",
      label: "Completion (Working Demo)",
      weight: 20,
      levels: [
        "Mostly broken. Cannot demonstrate the main idea.",
        "Parts work, but the demo fails or needs heavy workarounds.",
        "Main flow works in the demo, with some gaps or rough edges.",
        "Works end to end with only small issues. Handles a new input from the judges.",
        "Works reliably end to end, including a live input chosen by the judges. Team achieved what it set out to build.",
      ],
    },
    {
      field: "score3",
      label: "Idea: Clarity, Impact and Originality",
      weight: 20,
      levels: [
        "Problem and user are unclear. The solution is generic.",
        "Problem is understandable but vague. Limited usefulness or little difference from existing tools.",
        "Clear problem and user. Some usefulness and some differentiation.",
        "Specific, well-understood problem. Useful solution with a creative approach.",
        "Exceptionally clear need with strong potential value. Original approach with a clear advantage over alternatives.",
      ],
    },
    {
      field: "score4",
      label: "Understanding of Implementation",
      weight: 15,
      levels: [
        "Team cannot explain how the project works or where the model is used.",
        "Can describe the idea but not the flow. Only one member can answer.",
        "Can explain the main flow and the model used. Most members can answer.",
        "Explains the flow, model choice and key decisions clearly. Can point to the code where the model is used.",
        "Every member can explain the flow, trade-offs and what did not work. Clear command of how it is built.",
      ],
    },
    {
      field: "score5",
      label: "Design and Usability",
      weight: 10,
      levels: [
        "Confusing or unusable. No thought given to the user.",
        "Usable with effort. Layout or output is hard to read.",
        "Usable and readable, but plain.",
        "Clear, easy to use and designed around the user.",
        "Intuitive and polished. A first-time user could use it without help.",
      ],
    },
    {
      field: "score6",
      label: "Presentation and Q&A",
      weight: 10,
      levels: [
        "Unclear and hard to follow. Cannot answer questions.",
        "Understandable but disorganized. Weak answers to questions.",
        "Clear and structured. Covers the key points within the time.",
        "Confident and well structured. Good answers to questions.",
        "Exceptionally clear and engaging within 4 minutes. Strong, honest answers, including about limitations.",
      ],
    },
  ],
  maxScore: 10,
  totalMarks: 100,
  // Heaviest metric first.
  tieBreak: ["score1", "score2", "score3", "score4", "score5", "score6"],
  eligibility:
    "Pass or fail: a team must (1) use an open-source or open-weight AI model as an important part of its project and be able to name the model and its license, (2) have a working demo, and (3) have built the project at the event. Teams that do not pass are not scored.",
  eligibilityShort: "open-source or open-weight model (named, with license), a working demo, and built at the event. Otherwise not scored.",
};

export const RUBRICS: Record<EvalPhase, Rubric> = { mid: MID_RUBRIC, final: FINAL_RUBRIC };

/** Teams that go through from the mid evaluation to the final. */
export const FINALISTS = 40;

export type Scores = Partial<Record<ScoreField, number | null>>;

/**
 * Weighted total, rounded to a whole number, or null until every metric is
 * scored. Each point is worth weight% × totalMarks / maxScore: in the mid
 * round (20% each, out of 50, 1–5) a point is exactly 2 marks.
 */
export function finalScore(rubric: Rubric, scores: Scores): number | null {
  let total = 0;
  for (const m of rubric.metrics) {
    const s = scores[m.field];
    if (s == null) return null;
    total += (s * m.weight * rubric.totalMarks) / (rubric.maxScore * 100);
  }
  return Math.round(total);
}

export type Ranked<T> = T & { final: number; rank: number; tiedWith: number };

/**
 * Ranks fully scored entries by total, then by the tie-break metrics. Entries
 * equal on everything share a rank, and `tiedWith` counts the others sharing
 * their total so the panel can flag ties for the judges to resolve.
 */
export function rankEvaluations<T extends Scores>(rubric: Rubric, entries: T[]): Ranked<T>[] {
  const scored = entries
    .map((e) => ({ e, final: finalScore(rubric, e) }))
    .filter((x): x is { e: T; final: number } => x.final !== null);
  const compare = (a: { e: T; final: number }, b: { e: T; final: number }) => {
    if (b.final !== a.final) return b.final - a.final;
    for (const f of rubric.tieBreak) {
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

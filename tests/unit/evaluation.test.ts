import { describe, expect, it } from "vitest";

import { FINAL_RUBRIC, finalScore, levelIndex, MID_RUBRIC, rankEvaluations, SCORE_LABELS } from "@/lib/evaluation";

const sheet = (id: string, s: [number, number, number, number, number]) => ({ id, score1: s[0], score2: s[1], score3: s[2], score4: s[3], score5: s[4] });

describe("mid evaluation scoring", () => {
  it("weights five 1–5 scores at 20% each into a whole number out of 50", () => {
    expect(MID_RUBRIC.metrics.reduce((s, m) => s + m.weight, 0)).toBe(100);
    expect(finalScore(MID_RUBRIC, sheet("a", [5, 5, 5, 5, 5]))).toBe(50);
    expect(finalScore(MID_RUBRIC, sheet("a", [1, 1, 1, 1, 1]))).toBe(10);
    expect(finalScore(MID_RUBRIC, sheet("a", [4, 3, 5, 2, 4]))).toBe(36);
    expect(Number.isInteger(finalScore(MID_RUBRIC, sheet("a", [3, 4, 2, 5, 1])))).toBe(true);
  });

  it("has no total until every metric is scored", () => {
    expect(finalScore(MID_RUBRIC, { score1: 5, score2: 5, score3: 5, score4: 5, score5: null })).toBeNull();
  });

  it("ranks by total, separates equal totals by progress then understanding, and flags ties", () => {
    const ranked = rankEvaluations(MID_RUBRIC, [
      sheet("low", [2, 2, 2, 2, 2]),
      sheet("a", [4, 4, 3, 4, 4]), // 38, progress 3
      sheet("b", [4, 3, 5, 3, 4]), // 38, progress 5
      sheet("c", [3, 4, 5, 4, 3]), // 38, progress 5, understanding 4
      sheet("top", [5, 5, 5, 5, 5]),
      { id: "unscored", score1: 3, score2: null, score3: null, score4: null, score5: null },
    ]);
    expect(ranked.map((r) => [r.id, r.final, r.rank])).toEqual([
      ["top", 50, 1],
      ["c", 38, 2],
      ["b", 38, 3],
      ["a", 38, 4],
      ["low", 20, 5],
    ]);
    expect(ranked.find((r) => r.id === "b")!.tiedWith).toBe(2);
    expect(ranked.find((r) => r.id === "top")!.tiedWith).toBe(0);
  });

  it("gives identical sheets the same rank", () => {
    const ranked = rankEvaluations(MID_RUBRIC, [sheet("x", [3, 3, 3, 3, 3]), sheet("y", [3, 3, 3, 3, 3]), sheet("z", [1, 1, 1, 1, 1])]);
    expect(ranked.map((r) => r.rank)).toEqual([1, 1, 3]);
  });
});

describe("final evaluation scoring", () => {
  const final = (id: string, s: [number, number, number, number, number, number]) => ({
    id, score1: s[0], score2: s[1], score3: s[2], score4: s[3], score5: s[4], score6: s[5],
  });

  it("weights six 1–10 scores 25/20/20/15/10/10 into a whole number out of 100", () => {
    expect(FINAL_RUBRIC.metrics.map((m) => m.weight)).toEqual([25, 20, 20, 15, 10, 10]);
    expect(finalScore(FINAL_RUBRIC, final("a", [10, 10, 10, 10, 10, 10]))).toBe(100);
    expect(finalScore(FINAL_RUBRIC, final("a", [1, 1, 1, 1, 1, 1]))).toBe(10);
    // 8×2.5 + 7×2 + 9×2 + 6×1.5 + 5 + 4 = 70
    expect(finalScore(FINAL_RUBRIC, final("a", [8, 7, 9, 6, 5, 4]))).toBe(70);
    // 7×2.5 + 7×1.5 = 28 with the rest at 5 → 17.5 + 10 + 10 + 10.5 + 5 + 5 = 58
    expect(finalScore(FINAL_RUBRIC, final("a", [7, 5, 5, 7, 5, 5]))).toBe(58);
    expect(finalScore(FINAL_RUBRIC, { ...final("a", [9, 9, 9, 9, 9, 9]), score6: null })).toBeNull();
  });

  it("maps two scores to each rubric level on the 1–10 scale", () => {
    expect([1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((s) => SCORE_LABELS[levelIndex(FINAL_RUBRIC, s)])).toEqual([
      "Poor", "Poor", "Below Average", "Below Average", "Good", "Good", "Very Good", "Very Good", "Excellent", "Excellent",
    ]);
    expect([1, 2, 3, 4, 5].map((s) => levelIndex(MID_RUBRIC, s))).toEqual([0, 1, 2, 3, 4]);
  });

  it("separates equal totals by the heaviest metric first", () => {
    const ranked = rankEvaluations(FINAL_RUBRIC, [final("a", [6, 8, 8, 8, 8, 8]), final("b", [8, 6, 6, 8, 8, 8])]);
    // a: 15+16+16+12+8+8 = 75; b: 20+12+12+12+8+8 = 72 → a first despite b's higher technology score.
    expect(ranked.map((r) => [r.id, r.final])).toEqual([["a", 75], ["b", 72]]);
    // x: 15+14+14+10.5+7+7 = 67.5 → 68; y: 17.5+12+14+10.5+7+7 = 68. Equal, so technology decides.
    const tied = rankEvaluations(FINAL_RUBRIC, [final("x", [6, 7, 7, 7, 7, 7]), final("y", [7, 6, 7, 7, 7, 7])]);
    expect(tied.map((r) => [r.id, r.final, r.rank, r.tiedWith])).toEqual([["y", 68, 1, 1], ["x", 68, 2, 1]]);
  });
});

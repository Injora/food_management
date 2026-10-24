import { describe, expect, it } from "vitest";

import { finalScore, MID_RUBRIC, rankEvaluations } from "@/lib/evaluation";

const sheet = (id: string, s: [number, number, number, number, number]) => ({ id, score1: s[0], score2: s[1], score3: s[2], score4: s[3], score5: s[4] });

describe("mid evaluation scoring", () => {
  it("weights five 1–5 scores at 20% each into a whole number out of 50", () => {
    expect(MID_RUBRIC.reduce((s, m) => s + m.weight, 0)).toBe(100);
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

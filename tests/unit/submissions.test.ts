import { describe, expect, it } from "vitest";

import { matchSubmissionTeam, parseSubmissionRows, safeRepoUrl, type MatchableTeam } from "@/lib/submissions";

describe("safeRepoUrl", () => {
  it("keeps https links only", () => {
    expect(safeRepoUrl("https://github.com/a/b.git")).toBe("https://github.com/a/b.git");
    expect(safeRepoUrl("  https://github.com/a/b  ")).toBe("https://github.com/a/b");
    expect(safeRepoUrl("javascript:alert(1)")).toBeNull();
    expect(safeRepoUrl("http://github.com/a/b")).toBeNull();
    expect(safeRepoUrl("github.com/a/b")).toBeNull();
    expect(safeRepoUrl(null)).toBeNull();
  });

  it("keeps the first copy of a URL pasted twice", () => {
    expect(safeRepoUrl("https://github.com/a/b.githttps://github.com/a/b.git")).toBe("https://github.com/a/b.git");
    expect(safeRepoUrl("https://github.com/a/b https://github.com/a/b")).toBe("https://github.com/a/b");
  });
});

describe("parseSubmissionRows", () => {
  it("maps the form columns", () => {
    const rows = parseSubmissionRows([
      ["Time", "Team Name", "Team Leader Name", "Problem / Idea Title", "Problem / Idea Description", "GitHub Repository URL", "In the 20?", "Matched Problem Statement", "Notes"],
      ["16:44", " Byte  Bandits ", "Asha Rao", "Hive", "Crowd sim", "https://github.com/x/y", "Partial", "#20 Finder", ""],
      ["16:50", "", "x", "y", "z", "", "", "", ""],
      ["16:52", "Nulls", "Ravi", "Idea", "Desc", "not a url", "No", "-", "Pasted twice"],
    ]);
    expect(rows).toEqual([
      { submittedAt: "16:44", teamName: "Byte Bandits", leaderName: "Asha Rao", title: "Hive", description: "Crowd sim", repoUrl: "https://github.com/x/y", psMatch: "partial", matchedStatement: "#20 Finder", notes: null },
      { submittedAt: "16:52", teamName: "Nulls", leaderName: "Ravi", title: "Idea", description: "Desc", repoUrl: null, psMatch: "no", matchedStatement: null, notes: "Pasted twice" },
    ]);
  });
});

describe("matchSubmissionTeam", () => {
  const teams: MatchableTeam[] = [
    { id: "1", name: "Ophiuchus", leaderName: "Satish S", members: ["Satish S", "Ronit D"], active: true },
    { id: "2", name: "gitghost", leaderName: "kusumesh", members: ["kusumesh"], active: true },
    { id: "3", name: "GITGHOST", leaderName: "Kusumesh Talokar", members: ["Kusumesh Talokar"], active: false },
    { id: "4", name: "VicRaptors", leaderName: "Aditya Patil", members: ["Aditya Patil", "Tanishka Patil"], active: true },
  ];

  it("matches by team name, ignoring case and punctuation", () => {
    expect(matchSubmissionTeam({ teamName: "ophiuchus!", leaderName: null }, teams)).toBe("1");
  });

  it("separates teams sharing a name by leader, else prefers the active one", () => {
    expect(matchSubmissionTeam({ teamName: "GitGhost", leaderName: "Kusumesh Talokar" }, teams)).toBe("3");
    expect(matchSubmissionTeam({ teamName: "GitGhost", leaderName: "Someone" }, teams)).toBe("2");
  });

  it("falls back to the respondent's name when the team name differs", () => {
    expect(matchSubmissionTeam({ teamName: "Ophichus", leaderName: "Ronit D" }, teams)).toBe("1");
    expect(matchSubmissionTeam({ teamName: "Ukadiche Modak", leaderName: "Tanishka Patil" }, teams)).toBe("4");
    expect(matchSubmissionTeam({ teamName: "Nobody", leaderName: "Unknown Person" }, teams)).toBeNull();
  });
});

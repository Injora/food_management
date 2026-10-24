import { expect, it } from "vitest";

import { listEvaluations, pickFinalists, qualifyFinalists, saveEvaluation } from "@/server/services/evaluations";
import { createUser, listUsers, updateUser } from "@/server/services/users";
import { clearFailures, isLockedOut, MAX_FAILURES_PER_EMAIL, recordFailure } from "@/server/auth/throttle";
import { describeDb, expectAppError, makeActor, makeTeam, useTestDb } from "../helpers";

describeDb("Judging and super admins (PostgreSQL)", () => {
  const t = useTestDb();

  it("hides evaluations from admins and volunteers", async () => {
    const admin = await makeActor(t.db, "admin");
    const volunteer = await makeActor(t.db, "organizer");
    const { teamId } = await makeTeam(t.db, admin, "Alpha", 2);
    for (const actor of [admin, volunteer]) {
      await expectAppError(listEvaluations(t.db, actor, "mid"), "FORBIDDEN");
      await expectAppError(saveEvaluation(t.db, actor, { phase: "mid", teamId, field: "score1", value: 4 }), "FORBIDDEN");
    }
    await expectAppError(listEvaluations(t.db, null, "mid"), "UNAUTHORIZED");
  });

  it("lets super admins score one field at a time without overwriting each other", async () => {
    const admin = await makeActor(t.db, "admin");
    const judgeA = await makeActor(t.db, "superadmin");
    const judgeB = await makeActor(t.db, "superadmin");
    const { teamId } = await makeTeam(t.db, admin, "Beta", 3);

    await Promise.all([
      saveEvaluation(t.db, judgeA, { phase: "mid", teamId, field: "score1", value: 4 }),
      saveEvaluation(t.db, judgeB, { phase: "mid", teamId, field: "score3", value: 5 }),
      saveEvaluation(t.db, judgeA, { phase: "mid", teamId, field: "track", value: "gemma" }),
    ]);
    const row = (await listEvaluations(t.db, judgeA, "mid")).find((r) => r.teamId === teamId)!;
    expect([row.track, row.score1, row.score3, row.score2]).toEqual(["gemma", 4, 5, null]);
    expect(row.leaderName).toBe("Beta Member 1");

    await expectAppError(saveEvaluation(t.db, judgeA, { phase: "mid", teamId, field: "score2", value: 6 }), "VALIDATION");
    await expectAppError(saveEvaluation(t.db, judgeA, { phase: "mid", teamId, field: "score2", value: 2.5 }), "VALIDATION");
    await expectAppError(saveEvaluation(t.db, judgeA, { phase: "mid", teamId, field: "track", value: "closed" }), "VALIDATION");
    await expectAppError(saveEvaluation(t.db, judgeA, { phase: "mid", teamId, field: "score6", value: 3 }), "VALIDATION");
    await expectAppError(saveEvaluation(t.db, judgeA, { phase: "final", teamId, field: "score1", value: 3 }), "NOT_FOUND");
  });

  it("puts the top mid teams into the final, minus exclusions, and scores them 1–10", async () => {
    const admin = await makeActor(t.db, "admin");
    const judge = await makeActor(t.db, "superadmin");
    const score = async (teamId: string, s: number[], track: "gemma" | "open_source" = "gemma") => {
      for (const [i, v] of s.entries()) await saveEvaluation(t.db, judge, { phase: "mid", teamId, field: `score${i + 1}` as "score1", value: v });
      await saveEvaluation(t.db, judge, { phase: "mid", teamId, field: "track", value: track });
    };
    const teams: Record<string, string> = {};
    for (const name of ["Top", "Second", "Skip Me", "Third", "Fourth", "Fifth"]) teams[name] = (await makeTeam(t.db, admin, name, 2)).teamId;
    await score(teams.Top, [5, 5, 5, 5, 5], "open_source"); // 50
    await score(teams.Second, [4, 4, 5, 4, 4]); // 42
    await score(teams["Skip Me"], [4, 4, 4, 4, 4]); // 40
    await score(teams.Third, [4, 4, 4, 4, 3]); // 38
    await score(teams.Fourth, [3, 3, 3, 3, 3]); // 30
    await score(teams.Fifth, [3, 3, 3, 3, 3]); // 30, ties Fourth

    expect(await pickFinalists(t.db, judge, { count: 3, exclude: ["skip me "] })).toMatchObject([
      { teamName: "Top", midRank: 1, midTotal: 50, track: "open_source" },
      { teamName: "Second", midRank: 2 },
      { teamName: "Third", midRank: 4 },
    ]);
    await expectAppError(pickFinalists(t.db, judge, { count: 4, exclude: ["Skip Me"] }), "CONFLICT"); // cut-off inside a tie
    await expectAppError(pickFinalists(t.db, judge, { count: 3, exclude: ["Nobody"] }), "NOT_FOUND");
    await expectAppError(qualifyFinalists(t.db, admin, { count: 3 }), "FORBIDDEN");

    await qualifyFinalists(t.db, judge, { count: 3, exclude: ["Skip Me"] });
    await expectAppError(qualifyFinalists(t.db, judge, { count: 3 }), "CONFLICT"); // runs once
    const final = await listEvaluations(t.db, judge, "final");
    expect(final.map((r) => [r.teamName, r.track]).sort()).toEqual([["Second", "gemma"], ["Third", "gemma"], ["Top", "open_source"]]);
    expect(final.every((r) => r.score1 === null)).toBe(true);

    await saveEvaluation(t.db, judge, { phase: "final", teamId: teams.Top, field: "score6", value: 10 });
    await saveEvaluation(t.db, judge, { phase: "final", teamId: teams.Top, field: "score1", value: 7 });
    const top = (await listEvaluations(t.db, judge, "final")).find((r) => r.teamId === teams.Top)!;
    expect([top.score1, top.score6]).toEqual([7, 10]);
    await expectAppError(saveEvaluation(t.db, judge, { phase: "final", teamId: teams.Top, field: "score2", value: 11 }), "VALIDATION");
    await expectAppError(saveEvaluation(t.db, judge, { phase: "final", teamId: teams["Skip Me"], field: "score1", value: 5 }), "NOT_FOUND");
    // Mid marks are untouched and still capped at 5.
    expect((await listEvaluations(t.db, judge, "mid")).find((r) => r.teamId === teams.Top)!.score1).toBe(5);
    await expectAppError(saveEvaluation(t.db, judge, { phase: "mid", teamId: teams.Top, field: "score1", value: 7 }), "VALIDATION");
  });

  it("keeps super admin accounts out of admins' reach", async () => {
    const admin = await makeActor(t.db, "admin");
    const superadmin = await makeActor(t.db, "superadmin");

    expect((await listUsers(t.db, admin)).some((u) => u.id === superadmin.id)).toBe(false);
    expect((await listUsers(t.db, superadmin)).some((u) => u.id === superadmin.id)).toBe(true);
    await expectAppError(updateUser(t.db, admin, { userId: superadmin.id, password: "takeover-password" }), "NOT_FOUND");
    await expectAppError(updateUser(t.db, admin, { userId: superadmin.id, active: false }), "NOT_FOUND");
    await expectAppError(createUser(t.db, admin, { email: "sa@example.com", name: "S", role: "superadmin", password: "long-enough-pw" }), "FORBIDDEN");
    await expectAppError(updateUser(t.db, admin, { userId: admin.id, role: "superadmin" }), "FORBIDDEN");

    const { id } = await createUser(t.db, superadmin, { email: "judge@example.com", name: "Judge", role: "superadmin", password: "long-enough-pw" });
    expect(id).toBeTruthy();
    await expectAppError(updateUser(t.db, superadmin, { userId: superadmin.id, role: "admin" }), "CONFLICT");
  });

  it("locks out an email after repeated failed sign-ins", async () => {
    for (let i = 0; i < MAX_FAILURES_PER_EMAIL; i++) await recordFailure(t.db, "victim@x.y", `10.0.0.${i}`);
    expect(await isLockedOut(t.db, "victim@x.y", "10.0.0.99")).toBe(true);
    expect(await isLockedOut(t.db, "other@x.y", "10.0.0.99")).toBe(false);
    await clearFailures(t.db, "victim@x.y");
    expect(await isLockedOut(t.db, "victim@x.y", "10.0.0.99")).toBe(false);
  });
});

import { eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { auditLogs, distributions, sessions, teams } from "@/db/schema";
import { hashPassword } from "@/server/auth/password";
import { authenticate, createSession, validateSessionToken } from "@/server/auth/session";
import { listAudit } from "@/server/services/audit";
import { correctCouponQuantity, issueCoupons, listMealDistribution, revertIssuance } from "@/server/services/distribution";
import { buildExport } from "@/server/services/exports";
import { analyzeImport, commitImport } from "@/server/services/import";
import { getDashboardStats } from "@/server/services/stats";
import { correctMemberCount, createTeam, deleteTeam, updateTeam } from "@/server/services/teams";
import { createUser, listUsers, updateUser } from "@/server/services/users";
import { columnOptions, describeDb, expectAppError, makeActor, parseCsv, SPEC_CSV, useTestDb } from "../helpers";

const quantities = async (db: ReturnType<typeof useTestDb>["db"], teamId: string) =>
  Object.fromEntries(
    (await db.select().from(distributions).where(eq(distributions.teamId, teamId))).map((d) => [d.mealType, d.couponQuantity]),
  );

describeDb("Team member counts (PostgreSQL)", () => {
  const t = useTestDb();

  it("updates the member count and pending quantities before issuance", async () => {
    const admin = await makeActor(t.db);
    const { id } = await createTeam(t.db, admin, { teamName: "Null Pointers", memberCount: 3 });
    await updateTeam(t.db, admin, { teamId: id, teamName: "Null Pointers", memberCount: 4 });
    expect(await quantities(t.db, id)).toEqual({ breakfast: 4, lunch: 4, dinner: 4 });
    const [log] = await t.db.select().from(auditLogs).where(eq(auditLogs.action, "team_update"));
    expect(log).toMatchObject({ before: { memberCount: 3 }, after: { memberCount: 4 } });
  });

  it("prevents silent member-count changes after issuance", async () => {
    const admin = await makeActor(t.db);
    const { id } = await createTeam(t.db, admin, { teamName: "Null Pointers", memberCount: 3 });
    await issueCoupons(t.db, admin, { teamId: id, meal: "breakfast", expectedQuantity: 3, requestId: crypto.randomUUID() });

    await expectAppError(updateTeam(t.db, admin, { teamId: id, teamName: "Null Pointers", memberCount: 5 }), "MEMBER_COUNT_LOCKED");
    const [team] = await t.db.select().from(teams).where(eq(teams.id, id));
    expect(team.memberCount).toBe(3);

    // Non-count edits are still allowed.
    await updateTeam(t.db, admin, { teamId: id, teamName: "Null Pointers", leaderName: "Ira", memberCount: 3 });

    // The explicit correction requires a reason, leaves the issued meal alone
    // and updates the meals still pending.
    await expectAppError(correctMemberCount(t.db, admin, { teamId: id, memberCount: 5, reason: "" }), "VALIDATION");
    await correctMemberCount(t.db, admin, { teamId: id, memberCount: 5, reason: "Two late registrations" });
    expect(await quantities(t.db, id)).toEqual({ breakfast: 3, lunch: 5, dinner: 5 });
    const [log] = await t.db.select().from(auditLogs).where(eq(auditLogs.action, "member_count_correction"));
    expect(log).toMatchObject({
      reason: "Two late registrations",
      before: { memberCount: 3 },
      after: { memberCount: 5 },
      details: { pendingMealsUpdated: ["breakfast", "lunch", "dinner"].filter((m) => m !== "breakfast"), issuedMealsUnchanged: ["breakfast"] },
    });
  });

  it("rejects duplicate names and codes on manual create", async () => {
    const admin = await makeActor(t.db);
    await createTeam(t.db, admin, { teamName: "Kernel Panic", teamCode: "K1", memberCount: 2 });
    await expectAppError(createTeam(t.db, admin, { teamName: "kernel-panic", memberCount: 2 }), "CONFLICT");
    await expectAppError(createTeam(t.db, admin, { teamName: "Other", teamCode: "k1", memberCount: 2 }), "CONFLICT");
  });

  it("deletes a team only while nothing was issued", async () => {
    const admin = await makeActor(t.db);
    const a = await createTeam(t.db, admin, { teamName: "Alpha", memberCount: 2 });
    const b = await createTeam(t.db, admin, { teamName: "Beta", memberCount: 2 });
    await issueCoupons(t.db, admin, { teamId: b.id, meal: "lunch", expectedQuantity: 2, requestId: crypto.randomUUID() });
    await deleteTeam(t.db, admin, { teamId: a.id, reason: "Duplicate registration" });
    await expectAppError(deleteTeam(t.db, admin, { teamId: b.id, reason: "Duplicate registration" }), "CONFLICT");
    expect((await t.db.select().from(teams)).map((x) => x.teamName)).toEqual(["Beta"]);
  });
});

describeDb("Reports (PostgreSQL)", () => {
  const t = useTestDb();

  it("reports accurate team and coupon totals per meal", async () => {
    const admin = await makeActor(t.db);
    const organizer = await makeActor(t.db, "organizer");
    await commitImport(t.db, admin, { table: parseCsv(SPEC_CSV), options: columnOptions, mode: "add_only" });
    const rows = await t.db.select().from(teams);
    const byCode = Object.fromEntries(rows.map((r) => [r.teamCode, r]));
    const issue = (code: string, meal: "breakfast" | "lunch" | "dinner") =>
      issueCoupons(t.db, organizer, { teamId: byCode[code].id, meal, expectedQuantity: byCode[code].memberCount, requestId: crypto.randomUUID() });
    await issue("T001", "breakfast"); // 4
    await issue("T003", "breakfast"); // 5
    await issue("T002", "lunch"); // 3

    const stats = await getDashboardStats(t.db, organizer);
    expect(stats).toMatchObject({ totalTeams: 3, totalParticipants: 12, couponsIssuedToday: 12, couponsIssuedTotal: 12, couponsExpectedTotal: 36 });
    expect(stats.overallProgress).toBeCloseTo(3 / 9);
    const [breakfast, lunch, dinner] = stats.meals;
    expect(breakfast).toMatchObject({ eligibleTeams: 3, issuedTeams: 2, pendingTeams: 1, couponsExpected: 12, couponsIssued: 9, couponsRemaining: 3 });
    expect(lunch).toMatchObject({ issuedTeams: 1, couponsIssued: 3, couponsRemaining: 9 });
    expect(dinner).toMatchObject({ issuedTeams: 0, couponsIssued: 0, couponsRemaining: 12, lastIssuedAt: null });
    expect(stats.recent).toHaveLength(3);

    // Yesterday's issuance doesn't count toward "today".
    await t.db.execute(sql`update distributions set issued_at = now() - interval '2 days' where meal_type = 'lunch' and status = 'issued'`);
    expect((await getDashboardStats(t.db, organizer)).couponsIssuedToday).toBe(9);

    const pending = await buildExport(t.db, admin, "pending", "breakfast");
    expect(pending.rows.slice(1).map((r) => r[0])).toEqual(["T002"]);
    const meal = await buildExport(t.db, admin, "meal", "breakfast");
    expect(meal.rows.slice(1).map((r) => [r[0], r[5], r[6], r[8]])).toEqual([
      ["T001", 4, "issued", organizer.name],
      ["T003", 5, "issued", organizer.name],
      ["T002", 3, "pending", null],
    ]);
    const all = await buildExport(t.db, admin, "teams", null);
    expect(all.rows).toHaveLength(4);
    const audit = await buildExport(t.db, admin, "audit", null);
    expect(audit.rows.filter((r) => r[2] === "coupon_issue")).toHaveLength(3);
  });
});

describeDb("Authorization (PostgreSQL)", () => {
  const t = useTestDb();

  it("rejects unauthenticated callers on every protected operation", async () => {
    const ops = [
      issueCoupons(t.db, null, {}),
      listMealDistribution(t.db, null, "lunch"),
      getDashboardStats(t.db, null),
      analyzeImport(t.db, null, {}),
      commitImport(t.db, null, {}),
      updateTeam(t.db, null, {}),
      buildExport(t.db, null, "teams", null),
      listUsers(t.db, null),
    ];
    for (const op of ops) await expectAppError(op, "UNAUTHORIZED");
  });

  it("limits organizers to viewing and issuing", async () => {
    const admin = await makeActor(t.db);
    const organizer = await makeActor(t.db, "organizer");
    const { id } = await createTeam(t.db, admin, { teamName: "Gamma", memberCount: 2 });
    const req = { table: parseCsv(SPEC_CSV), options: columnOptions, mode: "add_only" };

    await expectAppError(analyzeImport(t.db, organizer, req), "FORBIDDEN");
    await expectAppError(commitImport(t.db, organizer, req), "FORBIDDEN");
    await expectAppError(createTeam(t.db, organizer, { teamName: "X", memberCount: 1 }), "FORBIDDEN");
    await expectAppError(updateTeam(t.db, organizer, { teamId: id, teamName: "Gamma", memberCount: 9 }), "FORBIDDEN");
    await expectAppError(correctMemberCount(t.db, organizer, { teamId: id, memberCount: 9, reason: "because" }), "FORBIDDEN");
    await expectAppError(correctCouponQuantity(t.db, organizer, { teamId: id, meal: "lunch", quantity: 9, reason: "because" }), "FORBIDDEN");
    await expectAppError(revertIssuance(t.db, organizer, { teamId: id, meal: "lunch", reason: "because" }), "FORBIDDEN");
    await expectAppError(buildExport(t.db, organizer, "audit", null), "FORBIDDEN");
    await expectAppError(listAudit(t.db, organizer), "FORBIDDEN");
    await expectAppError(createUser(t.db, organizer, { email: "x@y.z", name: "X", role: "admin", password: "long-enough-pw" }), "FORBIDDEN");

    // Allowed:
    await issueCoupons(t.db, organizer, { teamId: id, meal: "lunch", expectedQuantity: 2, requestId: crypto.randomUUID() });
    expect((await listAudit(t.db, organizer, { teamId: id })).rows.length).toBeGreaterThan(0);
    const [team] = await t.db.select().from(teams).where(eq(teams.id, id));
    expect(team.memberCount).toBe(2);
  });

  describe("sessions", () => {
    it("authenticates, validates and revokes sessions", async () => {
      const admin = await makeActor(t.db);
      const { id: userId } = await createUser(t.db, admin, { email: "Asha@Example.com", name: "Asha", role: "organizer", password: "a-strong-password" });
      expect(await authenticate(t.db, "asha@example.com", "wrong-password")).toBeNull();
      expect(await authenticate(t.db, "nobody@example.com", "a-strong-password")).toBeNull();
      const actor = await authenticate(t.db, " ASHA@example.com ", "a-strong-password");
      expect(actor).toMatchObject({ id: userId, role: "organizer" });

      const { token } = await createSession(t.db, userId);
      expect(await validateSessionToken(t.db, token)).toMatchObject({ id: userId });
      expect(await validateSessionToken(t.db, "forged-token")).toBeNull();
      expect(await validateSessionToken(t.db, undefined)).toBeNull();

      // Deactivation revokes sessions and blocks sign-in.
      await updateUser(t.db, admin, { userId, active: false });
      expect(await validateSessionToken(t.db, token)).toBeNull();
      expect(await t.db.select().from(sessions).where(eq(sessions.userId, userId))).toHaveLength(0);
      expect(await authenticate(t.db, "asha@example.com", "a-strong-password")).toBeNull();
    });

    it("expires sessions", async () => {
      const admin = await makeActor(t.db, "admin", await hashPassword("whatever-password"));
      const { token } = await createSession(t.db, admin.id);
      await t.db.update(sessions).set({ expiresAt: new Date(Date.now() - 1000) });
      expect(await validateSessionToken(t.db, token)).toBeNull();
    });

    it("keeps at least one active admin", async () => {
      const admin = await makeActor(t.db);
      await expectAppError(updateUser(t.db, admin, { userId: admin.id, role: "organizer" }), "CONFLICT");
      const other = await makeActor(t.db);
      await updateUser(t.db, admin, { userId: other.id, active: false });
      await expectAppError(updateUser(t.db, other, { userId: admin.id, active: false }), "CONFLICT");
    });
  });
});

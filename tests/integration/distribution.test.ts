import { and, eq, sql } from "drizzle-orm";
import { expect, it } from "vitest";

import { auditLogs, distributions, teams } from "@/db/schema";
import { AppError } from "@/lib/errors";
import {
  correctCouponQuantity,
  issueCoupons,
  listMealDistribution,
  revertIssuance,
} from "@/server/services/distribution";
import { createTeam } from "@/server/services/teams";
import { describeDb, expectAppError, makeActor, useTestDb } from "../helpers";

describeDb("Coupon issuance (PostgreSQL)", () => {
  const t = useTestDb();

  async function setup(memberCount = 4) {
    const admin = await makeActor(t.db, "admin");
    const organizer = await makeActor(t.db, "organizer");
    const team = await createTeam(t.db, admin, { teamName: "Byte Builders", teamCode: "T001", memberCount });
    return { admin, organizer, teamId: team.id };
  }
  const mealStatus = async (teamId: string) =>
    Object.fromEntries(
      (await t.db.select().from(distributions).where(eq(distributions.teamId, teamId))).map((d) => [d.mealType, d.status]),
    );

  it("issues breakfast without touching lunch or dinner", async () => {
    const { organizer, teamId } = await setup();
    const res = await issueCoupons(t.db, organizer, { teamId, meal: "breakfast", expectedQuantity: 4, requestId: crypto.randomUUID() });
    expect(res).toMatchObject({ meal: "breakfast", couponQuantity: 4, replayed: false, issuedByName: organizer.name });
    expect(await mealStatus(teamId)).toEqual({ breakfast: "issued", lunch: "pending", dinner: "pending" });

    const lunch = await listMealDistribution(t.db, organizer, "lunch");
    expect(lunch[0]).toMatchObject({ status: "pending", issuedAt: null });
  });

  it("issues lunch with the team's member count and records who and when", async () => {
    const { organizer, teamId } = await setup(5);
    const before = Date.now();
    await issueCoupons(t.db, organizer, { teamId, meal: "lunch", expectedQuantity: 5, requestId: crypto.randomUUID() });
    const [row] = await t.db
      .select()
      .from(distributions)
      .where(and(eq(distributions.teamId, teamId), eq(distributions.mealType, "lunch")));
    expect(row).toMatchObject({ status: "issued", couponQuantity: 5, issuedBy: organizer.id });
    expect(row.issuedAt!.getTime()).toBeGreaterThanOrEqual(before - 5000);

    const [log] = await t.db.select().from(auditLogs).where(eq(auditLogs.action, "coupon_issue"));
    expect(log).toMatchObject({ actorId: organizer.id, teamId, mealType: "lunch", after: { couponQuantity: 5, status: "issued" } });
  });

  it("rejects a second issuance of the same meal", async () => {
    const { organizer, admin, teamId } = await setup();
    await issueCoupons(t.db, organizer, { teamId, meal: "dinner", expectedQuantity: 4, requestId: crypto.randomUUID() });
    const err = await expectAppError(
      issueCoupons(t.db, admin, { teamId, meal: "dinner", expectedQuantity: 4, requestId: crypto.randomUUID() }),
      "ALREADY_ISSUED",
    );
    expect(err.message).toContain(organizer.name);
    expect(err.details).toMatchObject({ issuedByName: organizer.name, couponQuantity: 4 });
    const issues = await t.db.select().from(auditLogs).where(eq(auditLogs.action, "coupon_issue"));
    expect(issues).toHaveLength(1);
  });

  it("treats a retried request with the same id as a replay, not a new issuance", async () => {
    const { organizer, teamId } = await setup();
    const input = { teamId, meal: "lunch", expectedQuantity: 4, requestId: crypto.randomUUID() };
    await issueCoupons(t.db, organizer, input);
    const replay = await issueCoupons(t.db, organizer, input);
    expect(replay.replayed).toBe(true);
    expect(await t.db.select().from(auditLogs).where(eq(auditLogs.action, "coupon_issue"))).toHaveLength(1);
  });

  it("lets exactly one of many concurrent requests succeed", async () => {
    const { teamId } = await setup();
    const organizers = await Promise.all(Array.from({ length: 10 }, () => makeActor(t.db, "organizer")));
    const results = await Promise.allSettled(
      organizers.map((o) =>
        issueCoupons(t.db, o, { teamId, meal: "breakfast", expectedQuantity: 4, requestId: crypto.randomUUID() }),
      ),
    );
    const ok = results.filter((r) => r.status === "fulfilled");
    const failed = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(ok).toHaveLength(1);
    expect(failed).toHaveLength(9);
    for (const f of failed) {
      expect(f.reason).toBeInstanceOf(AppError);
      expect((f.reason as AppError).code).toBe("ALREADY_ISSUED");
    }
    expect(await t.db.select().from(auditLogs).where(eq(auditLogs.action, "coupon_issue"))).toHaveLength(1);
  });

  it("rejects issuance when the confirmed quantity is stale", async () => {
    const { organizer, teamId } = await setup(4);
    const err = await expectAppError(
      issueCoupons(t.db, organizer, { teamId, meal: "lunch", expectedQuantity: 3, requestId: crypto.randomUUID() }),
      "QUANTITY_CHANGED",
    );
    expect(err.details).toEqual({ couponQuantity: 4 });
    expect((await mealStatus(teamId)).lunch).toBe("pending");
  });

  it("rejects missing teams and invalid input", async () => {
    const { organizer } = await setup();
    await expectAppError(
      issueCoupons(t.db, organizer, { teamId: crypto.randomUUID(), meal: "lunch", expectedQuantity: 4, requestId: crypto.randomUUID() }),
      "NOT_FOUND",
    );
    await expectAppError(
      issueCoupons(t.db, organizer, { teamId: crypto.randomUUID(), meal: "supper", expectedQuantity: 4, requestId: crypto.randomUUID() }),
      "VALIDATION",
    );
    await expectAppError(
      issueCoupons(t.db, organizer, { teamId: crypto.randomUUID(), meal: "lunch", expectedQuantity: 0, requestId: crypto.randomUUID() }),
      "VALIDATION",
    );
  });

  it("reverts an issuance only with a reason, keeping the history", async () => {
    const { organizer, admin, teamId } = await setup();
    await issueCoupons(t.db, organizer, { teamId, meal: "lunch", expectedQuantity: 4, requestId: crypto.randomUUID() });
    await expectAppError(revertIssuance(t.db, organizer, { teamId, meal: "lunch", reason: "mistake at counter" }), "FORBIDDEN");
    await expectAppError(revertIssuance(t.db, admin, { teamId, meal: "lunch", reason: "" }), "VALIDATION");
    await revertIssuance(t.db, admin, { teamId, meal: "lunch", reason: "Issued to the wrong team" });
    expect((await mealStatus(teamId)).lunch).toBe("pending");
    await expectAppError(revertIssuance(t.db, admin, { teamId, meal: "lunch", reason: "again please" }), "NOT_ISSUED");

    const logs = await t.db.select().from(auditLogs).where(eq(auditLogs.teamId, teamId));
    expect(logs.map((l) => l.action).sort()).toEqual(["coupon_issue", "coupon_reversal", "team_create"]);
    const reversal = logs.find((l) => l.action === "coupon_reversal")!;
    expect(reversal).toMatchObject({ reason: "Issued to the wrong team", before: { status: "issued", issuedBy: organizer.name } });

    // Can be issued again afterwards.
    await issueCoupons(t.db, organizer, { teamId, meal: "lunch", expectedQuantity: 4, requestId: crypto.randomUUID() });
  });

  it("corrects an issued quantity explicitly and logs before/after", async () => {
    const { organizer, admin, teamId } = await setup();
    await issueCoupons(t.db, organizer, { teamId, meal: "breakfast", expectedQuantity: 4, requestId: crypto.randomUUID() });
    await correctCouponQuantity(t.db, admin, { teamId, meal: "breakfast", quantity: 5, reason: "Gave one extra to a guest" });
    const [log] = await t.db.select().from(auditLogs).where(eq(auditLogs.action, "coupon_quantity_correction"));
    expect(log).toMatchObject({ before: { couponQuantity: 4, status: "issued" }, after: { couponQuantity: 5, status: "issued" } });
  });

  it("database constraints back up the service rules", async () => {
    const { teamId } = await setup();
    await expect(t.db.insert(distributions).values({ teamId, mealType: "lunch", couponQuantity: 4 })).rejects.toThrow();
    await expect(t.db.execute(sql`update distributions set coupon_quantity = 0 where team_id = ${teamId}`)).rejects.toThrow();
    await expect(t.db.execute(sql`update distributions set status = 'issued' where team_id = ${teamId}`)).rejects.toThrow();
    await expect(t.db.execute(sql`update teams set member_count = -1 where id = ${teamId}`)).rejects.toThrow();
    const [team] = await t.db.select().from(teams).where(eq(teams.id, teamId));
    expect(team.memberCount).toBe(4);
  });
});

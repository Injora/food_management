import { and, eq, isNull } from "drizzle-orm";
import { expect, it } from "vitest";

import { auditLogs, checkIns, couponIssuances } from "@/db/schema";
import { checkIn, undoCheckIn } from "@/server/services/checkin";
import { issueCoupons, revertCoupon } from "@/server/services/coupons";
import { withdrawParticipant } from "@/server/services/teams";
import { describeDb, expectAppError, makeActor, makeTeam, teamState, useTestDb } from "../helpers";

describeDb("Team check-in (PostgreSQL)", () => {
  const t = useTestDb();

  it("checks in a complete team with the explicit whole-team action", async () => {
    const admin = await makeActor(t.db);
    const volunteer = await makeActor(t.db, "organizer");
    const { teamId, memberIds } = await makeTeam(t.db, admin, "Team Alpha", 4);

    expect((await teamState(t.db, volunteer, teamId)).status).toBe("none");
    const res = await checkIn(t.db, volunteer, { teamId, wholeTeam: true });
    expect(res).toMatchObject({ present: 4, size: 4 });
    expect(res.checkedIn.sort()).toEqual([...memberIds].sort());

    const team = await teamState(t.db, volunteer, teamId);
    expect(team).toMatchObject({ present: 4, size: 4, status: "full" });
    expect(team.members.every((m) => m.checkIn?.by === volunteer.name)).toBe(true);
    const rows = await t.db.select().from(checkIns).where(eq(checkIns.teamId, teamId));
    expect(rows.every((r) => r.checkedInBy === volunteer.id)).toBe(true);
    const [log] = await t.db.select().from(auditLogs).where(eq(auditLogs.action, "check_in"));
    expect(log).toMatchObject({ actorId: volunteer.id, teamId, after: { present: 4, size: 4, status: "full" } });
  });

  it("checks in only the members who arrived (partial team)", async () => {
    const admin = await makeActor(t.db);
    const { teamId, memberIds } = await makeTeam(t.db, admin, "Partial", 4);
    await checkIn(t.db, admin, { teamId, participantIds: [memberIds[0]] });
    await checkIn(t.db, admin, { teamId, participantIds: [memberIds[2]] });

    const team = await teamState(t.db, admin, teamId);
    expect(team).toMatchObject({ present: 2, size: 4, status: "partial" });
    expect(team.members.map((m) => !!m.checkIn)).toEqual([true, false, true, false]);
  });

  it("never creates duplicate attendance, even for concurrent or repeated requests", async () => {
    const admin = await makeActor(t.db);
    const { teamId, memberIds } = await makeTeam(t.db, admin, "Dupes", 3);
    const volunteers = await Promise.all(Array.from({ length: 6 }, () => makeActor(t.db, "organizer")));
    await Promise.all(volunteers.map((v) => checkIn(t.db, v, { teamId, participantIds: [memberIds[0]] })));
    const again = await checkIn(t.db, admin, { teamId, wholeTeam: true });
    expect(again.alreadyPresent).toEqual([memberIds[0]]);
    const live = await t.db.select().from(checkIns).where(and(eq(checkIns.teamId, teamId), isNull(checkIns.undoneAt)));
    expect(live).toHaveLength(3);
  });

  it("reverts an accidental check-in, keeping the history", async () => {
    const admin = await makeActor(t.db);
    const volunteer = await makeActor(t.db, "organizer");
    const { teamId, memberIds } = await makeTeam(t.db, admin, "Oops", 3);
    await checkIn(t.db, volunteer, { teamId, wholeTeam: true });

    const res = await undoCheckIn(t.db, volunteer, { teamId, participantIds: [memberIds[1]], reason: "Wrong person ticked" });
    expect(res).toMatchObject({ present: 2, size: 3 });
    expect((await teamState(t.db, admin, teamId)).status).toBe("partial");
    const [undone] = await t.db.select().from(checkIns).where(eq(checkIns.participantId, memberIds[1]));
    expect(undone).toMatchObject({ undoneBy: volunteer.id, undoReason: "Wrong person ticked" });
    expect(undone.undoneAt).not.toBeNull();
    await expectAppError(undoCheckIn(t.db, volunteer, { teamId, participantIds: [memberIds[1]] }), "NOT_ISSUED");

    // Checking in again later is a fresh record.
    await checkIn(t.db, volunteer, { teamId, participantIds: [memberIds[1]] });
    expect((await teamState(t.db, admin, teamId)).status).toBe("full");
    expect(await t.db.select().from(checkIns).where(eq(checkIns.participantId, memberIds[1]))).toHaveLength(2);
  });

  it("rejects people who are not on the team", async () => {
    const admin = await makeActor(t.db);
    const a = await makeTeam(t.db, admin, "Team A", 2);
    const b = await makeTeam(t.db, admin, "Team B", 2);
    await expectAppError(checkIn(t.db, admin, { teamId: a.teamId, participantIds: [b.memberIds[0]] }), "VALIDATION");
    // The database also refuses a check-in pinned to the wrong team.
    await expect(t.db.insert(checkIns).values({ participantId: b.memberIds[0], teamId: a.teamId })).rejects.toThrow();
  });

  it("requires a signed-in user", async () => {
    const admin = await makeActor(t.db);
    const { teamId } = await makeTeam(t.db, admin, "Auth", 1);
    await expectAppError(checkIn(t.db, null, { teamId, wholeTeam: true }), "UNAUTHORIZED");
  });
});

describeDb("Food coupons (PostgreSQL)", () => {
  const t = useTestDb();
  const req = () => crypto.randomUUID();

  it("issues lunch, snacks and dinner independently", async () => {
    const admin = await makeActor(t.db);
    const volunteer = await makeActor(t.db, "organizer");
    const { teamId, memberIds } = await makeTeam(t.db, admin, "Meals", 4);

    const lunch = await issueCoupons(t.db, volunteer, { teamId, couponType: "lunch", allPending: true, requestId: req() });
    expect(lunch).toMatchObject({ issued: 4, entitled: 4 });
    let team = await teamState(t.db, admin, teamId);
    expect(team.coupons).toEqual({ lunch: 4, snacks: 0, dinner: 0 });

    await issueCoupons(t.db, volunteer, { teamId, couponType: "snacks", participantIds: [memberIds[0]], requestId: req() });
    await issueCoupons(t.db, volunteer, { teamId, couponType: "dinner", participantIds: [memberIds[3]], requestId: req() });
    team = await teamState(t.db, admin, teamId);
    expect(team.coupons).toEqual({ lunch: 4, snacks: 1, dinner: 1 });
    expect(team.members[0].coupons.snacks?.by).toBe(volunteer.name);
    expect(team.members[0].coupons.dinner).toBeNull();

    const rows = await t.db.select().from(couponIssuances).where(eq(couponIssuances.teamId, teamId));
    expect(rows).toHaveLength(6);
    expect(rows.every((r) => r.issuedBy === volunteer.id && r.issuedAt instanceof Date)).toBe(true);
    const logs = await t.db.select().from(auditLogs).where(eq(auditLogs.action, "coupon_issue"));
    expect(logs.map((l) => l.couponType).sort()).toEqual(["dinner", "lunch", "snacks"]);
  });

  it("rejects a duplicate coupon for the same person and meal", async () => {
    const admin = await makeActor(t.db);
    const { teamId, memberIds } = await makeTeam(t.db, admin, "Twice", 2);
    await issueCoupons(t.db, admin, { teamId, couponType: "lunch", participantIds: [memberIds[0]], requestId: req() });
    const err = await expectAppError(
      issueCoupons(t.db, admin, { teamId, couponType: "lunch", participantIds: [memberIds[0]], requestId: req() }),
      "ALREADY_ISSUED",
    );
    expect(err.message).toContain("already received a lunch coupon");
    // The partial unique index refuses a second live coupon even if the service is bypassed.
    await expect(t.db.insert(couponIssuances).values({ participantId: memberIds[0], teamId, couponType: "lunch" })).rejects.toThrow();
  });

  it("treats a retried request as a replay, not a second issuance", async () => {
    const admin = await makeActor(t.db);
    const { teamId } = await makeTeam(t.db, admin, "Retry", 3);
    const input = { teamId, couponType: "dinner", allPending: true, requestId: req() };
    const first = await issueCoupons(t.db, admin, input);
    const replay = await issueCoupons(t.db, admin, input);
    expect(first.replayed).toBe(false);
    expect(replay).toMatchObject({ replayed: true, issued: 3 });
    expect(await t.db.select().from(couponIssuances)).toHaveLength(3);
  });

  it("never over-issues when many volunteers click at once", async () => {
    const admin = await makeActor(t.db);
    const { teamId } = await makeTeam(t.db, admin, "Rush", 4);
    const volunteers = await Promise.all(Array.from({ length: 10 }, () => makeActor(t.db, "organizer")));
    const results = await Promise.allSettled(
      volunteers.map((v) => issueCoupons(t.db, v, { teamId, couponType: "lunch", allPending: true, requestId: req() })),
    );
    const ok = results.filter((r) => r.status === "fulfilled");
    expect(ok).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected").every((r) => (r as PromiseRejectedResult).reason.code === "ALREADY_ISSUED")).toBe(true);
    expect(await t.db.select().from(couponIssuances)).toHaveLength(4);
    expect((await teamState(t.db, admin, teamId)).coupons.lunch).toBe(4);
  });

  it("never issues more than the entitlement, one at a time", async () => {
    const admin = await makeActor(t.db);
    const { teamId, memberIds } = await makeTeam(t.db, admin, "Entitled", 2);
    for (const id of memberIds) await issueCoupons(t.db, admin, { teamId, couponType: "snacks", participantIds: [id], requestId: req() });
    await expectAppError(issueCoupons(t.db, admin, { teamId, couponType: "snacks", allPending: true, requestId: req() }), "ALREADY_ISSUED");
    expect((await teamState(t.db, admin, teamId)).coupons.snacks).toBe(2);
  });

  it("does not entitle withdrawn members", async () => {
    const admin = await makeActor(t.db);
    const { teamId, memberIds } = await makeTeam(t.db, admin, "Shrink", 3);
    await withdrawParticipant(t.db, admin, { participantId: memberIds[2], reason: "Did not attend" });
    const res = await issueCoupons(t.db, admin, { teamId, couponType: "lunch", allPending: true, requestId: req() });
    expect(res).toMatchObject({ issued: 2, entitled: 2 });
    await expectAppError(issueCoupons(t.db, admin, { teamId, couponType: "dinner", participantIds: [memberIds[2]], requestId: req() }), "VALIDATION");
  });

  it("lets only admins revert a coupon, with a reason, freeing the entitlement", async () => {
    const admin = await makeActor(t.db);
    const volunteer = await makeActor(t.db, "organizer");
    const { teamId, memberIds } = await makeTeam(t.db, admin, "Revert", 2);
    await issueCoupons(t.db, volunteer, { teamId, couponType: "lunch", participantIds: [memberIds[0]], requestId: req() });
    const [row] = await t.db.select().from(couponIssuances);

    await expectAppError(revertCoupon(t.db, volunteer, { issuanceId: row.id, reason: "Handed to wrong person" }), "FORBIDDEN");
    await expectAppError(revertCoupon(t.db, admin, { issuanceId: row.id, reason: "x" }), "VALIDATION");
    await revertCoupon(t.db, admin, { issuanceId: row.id, reason: "Handed to wrong person" });
    await expectAppError(revertCoupon(t.db, admin, { issuanceId: row.id, reason: "Handed to wrong person" }), "NOT_ISSUED");

    expect((await teamState(t.db, admin, teamId)).coupons.lunch).toBe(0);
    const [log] = await t.db.select().from(auditLogs).where(eq(auditLogs.action, "coupon_reversal"));
    expect(log).toMatchObject({ actorId: admin.id, couponType: "lunch", reason: "Handed to wrong person" });
    // The entitlement can now be used once more.
    await issueCoupons(t.db, volunteer, { teamId, couponType: "lunch", participantIds: [memberIds[0]], requestId: req() });
    expect(await t.db.select().from(couponIssuances)).toHaveLength(2);
  });
});

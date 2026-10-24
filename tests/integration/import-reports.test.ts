import { eq, sql } from "drizzle-orm";
import { expect, it } from "vitest";

import { checkIns, couponIssuances, participants, registrationImports, roomAllocations, teams } from "@/db/schema";
import { detectMapping, mappingBaseSchema, prepareTable } from "@/lib/registration-import";
import { checkIn } from "@/server/services/checkin";
import { issueCoupons } from "@/server/services/coupons";
import { buildExport } from "@/server/services/exports";
import { analyzeImport, commitImport, type ImportRequest } from "@/server/services/import";
import { allocateTeam } from "@/server/services/rooms";
import { describeDb, expectAppError, makeActor, parseRows, readFixture, room, teamState, useTestDb } from "../helpers";

function request(text: string, mode: ImportRequest["mode"] = "add_only", fileName = "registrations.csv"): ImportRequest {
  const raw = parseRows(text);
  const table = prepareTable(raw);
  return { fileName, headerRow: table.headerRow, raw, mapping: mappingBaseSchema.parse(detectMapping(table)), mode };
}

describeDb("Registration import (PostgreSQL)", () => {
  const t = useTestDb();

  it("imports one-row-per-team files, with and without a header row", async () => {
    const admin = await makeActor(t.db);
    const withHeader = await commitImport(t.db, admin, request(readFixture("team-rows-header.csv")));
    expect(withHeader.summary).toMatchObject({ teamsInFile: 7, create: 7, participantsToCreate: 15, errors: 1 });
    const noHeader = await commitImport(t.db, admin, request(readFixture("team-rows-no-header.csv"), "add_only", "late.csv"));
    expect(noHeader.summary).toMatchObject({ teamsInFile: 4, create: 4, participantsToCreate: 12, skippedRows: 1 });

    expect(await t.db.select().from(teams)).toHaveLength(11);
    expect(await t.db.select().from(participants)).toHaveLength(27);
    const [stack] = await t.db.select().from(teams).where(eq(teams.teamName, "Stack Testers"));
    expect(stack).toMatchObject({ teamCode: "STACK-TESTERS", college: "Test Institute", declaredMemberCount: 4, declaredRegisteredCount: 2 });
    expect(stack.source).toMatchObject({ fileName: "late.csv", rowNumbers: [3] });
    const members = await t.db.select().from(participants).where(eq(participants.teamId, stack.id));
    expect(members.filter((m) => m.isLeader).map((m) => [m.name, m.phone, m.email])).toEqual([["Arjun Mehta", "+919700000001", "arjun@example.test"]]);
    // Two different teams with the same name get distinct codes.
    const same = await t.db.select({ code: teams.teamCode }).from(teams).where(eq(teams.teamName, "Same Name"));
    expect(same.map((s) => s.code).sort()).toEqual(["SAME-NAME", "SAME-NAME-2"]);
    expect(await t.db.select().from(registrationImports)).toHaveLength(2);
  });

  it("imports one-row-per-participant files", async () => {
    const admin = await makeActor(t.db);
    const report = await commitImport(t.db, admin, request(readFixture("participant-rows.csv")));
    expect(report.summary).toMatchObject({ create: 2, participantsToCreate: 6 });
    const [ninjas] = await t.db.select().from(teams).where(eq(teams.teamName, "Neural Ninjas"));
    const members = await t.db.select().from(participants).where(eq(participants.teamId, ninjas.id));
    expect(members.map((m) => m.externalId).sort()).toEqual(["R-001", "R-002", "R-004"]);
  });

  it("detects duplicates against existing registrations and never duplicates on re-import", async () => {
    const admin = await makeActor(t.db);
    await commitImport(t.db, admin, request(readFixture("team-rows-header.csv")));
    const again = await analyzeImport(t.db, admin, request(readFixture("team-rows-header.csv")));
    expect(again.summary).toMatchObject({ create: 0, unchanged: 7 });

    // A second file registering another "Byte Builders" (different leader) and
    // re-using a participant from an existing team.
    const other = [
      "Team Name,Team Leader Name,Team Leader Email,Member 2 Name,Member 2 Email",
      "Byte Builders,New Leader,new@example.test,Rohan Iyer,rohan@example.test",
    ].join("\n");
    const analysis = await analyzeImport(t.db, admin, request(other));
    expect(analysis.summary.create).toBe(1);
    const msgs = analysis.issues.map((i) => i.message);
    expect(msgs.some((m) => m.startsWith('A different registration named "Byte Builders" (BYTE-BUILDERS) already exists'))).toBe(true);
    expect(msgs.some((m) => m.startsWith('Rohan Iyer is already registered in team "Byte Builders"'))).toBe(true);
    expect(analysis.teams[0].finalCode).toBe("BYTE-BUILDERS-2");
  });

  it("preserves check-ins, coupons and room allocations on re-import, and adds new members", async () => {
    const admin = await makeActor(t.db);
    await commitImport(t.db, admin, request(readFixture("team-rows-no-header.csv")));
    const [team] = await t.db.select().from(teams).where(eq(teams.teamName, "Two Brain Cells"));
    const before = await teamState(t.db, admin, team.id);
    const ids = before.members.map((m) => m.id);
    await checkIn(t.db, admin, { teamId: team.id, wholeTeam: true });
    await issueCoupons(t.db, admin, { teamId: team.id, couponType: "lunch", allPending: true, requestId: crypto.randomUUID() });
    const r401 = await room(t.db, "talks", "401");
    await allocateTeam(t.db, admin, { sessionId: "talks", teamId: team.id, roomId: r401.id, participantIds: ids });

    // The organiser fixes the file: a 4th member and a corrected phone number.
    const fixed = readFixture("team-rows-no-header.csv").replace(
      "Two Brain Cells,4,2,Esha Gupta,+919700000005,esha@example.test,Test Institute,Farhan Ali,farhan@example.test,+919700000006,Gauri Joshi,gauri@example.test,+919700000007,,,",
      "Two Brain Cells,4,4,Esha Gupta,+919700000005,esha@example.test,Test Institute,Farhan Ali,farhan@example.test,+919711111111,Gauri Joshi,gauri@example.test,+919700000007,Hari Om,hari@example.test,+919700000099",
    );
    const addOnly = await analyzeImport(t.db, admin, request(fixed));
    expect(addOnly.teams.find((x) => x.teamName === "Two Brain Cells")!.action).toBe("skip_existing");

    const report = await commitImport(t.db, admin, request(fixed, "update_existing"));
    expect(report.summary).toMatchObject({ create: 0, update: 1, participantsToCreate: 1, participantsToUpdate: 1 });

    const after = await teamState(t.db, admin, team.id);
    expect(after.size).toBe(4);
    // Same participant records (ids) keep their history.
    for (const id of ids) {
      const m = after.members.find((x) => x.id === id)!;
      expect(m.checkIn).not.toBeNull();
      expect(m.coupons.lunch).not.toBeNull();
      expect(m.rooms.talks).toBe(r401.id);
    }
    expect(after.members.find((m) => m.name === "Farhan Ali")!.phone).toBe("+919711111111");
    expect(after).toMatchObject({ present: 3, status: "partial" });
    expect(after.coupons.lunch).toBe(3);
    expect(await t.db.select().from(checkIns)).toHaveLength(3);
    expect(await t.db.select().from(couponIssuances)).toHaveLength(3);
    expect(await t.db.select().from(roomAllocations)).toHaveLength(3);
  });

  it("imports transactionally: a failure part-way leaves nothing behind", async () => {
    const admin = await makeActor(t.db);
    const req = request(readFixture("team-rows-header.csv"));
    // A mapping pointing outside the file is rejected before anything is written.
    await expectAppError(commitImport(t.db, admin, { ...req, mapping: { ...req.mapping, college: 99 } }), "VALIDATION");
    // Make the database fail on the very last participant of the batch.
    await t.db.execute(sql`create function fail_on_zoya() returns trigger language plpgsql as $$ begin raise exception 'simulated failure'; end $$`);
    await t.db.execute(sql`create trigger fail_on_zoya before insert on participants for each row when (new.name = 'Zoya Khan') execute function fail_on_zoya()`);
    try {
      await expect(commitImport(t.db, admin, req)).rejects.toThrow();
    } finally {
      await t.db.execute(sql`drop trigger fail_on_zoya on participants`);
      await t.db.execute(sql`drop function fail_on_zoya()`);
    }
    expect(await t.db.select().from(teams)).toHaveLength(0);
    expect(await t.db.select().from(participants)).toHaveLength(0);
    expect(await t.db.select().from(registrationImports)).toHaveLength(0);
    // Volunteers can't import at all.
    await expectAppError(commitImport(t.db, await makeActor(t.db, "organizer"), req), "FORBIDDEN");
  });
});

describeDb("Reports (PostgreSQL)", () => {
  const t = useTestDb();

  it("exports attendance and coupons from persisted records", async () => {
    const admin = await makeActor(t.db);
    await commitImport(t.db, admin, request(readFixture("team-rows-no-header.csv")));
    const [team] = await t.db.select().from(teams).where(eq(teams.teamName, "Stack Testers"));
    const state = await teamState(t.db, admin, team.id);
    await checkIn(t.db, admin, { teamId: team.id, participantIds: state.members.slice(0, 3).map((m) => m.id) });
    await issueCoupons(t.db, admin, { teamId: team.id, couponType: "snacks", participantIds: [state.members[0].id], requestId: crypto.randomUUID() });

    const present = await buildExport(t.db, admin, "attendance", new URLSearchParams("status=present"));
    expect(present.rows).toHaveLength(1 + 3);
    expect(present.rows.slice(1).every((r) => r[1] === "Stack Testers" && r[9] === "yes")).toBe(true);

    const absent = await buildExport(t.db, admin, "attendance", new URLSearchParams("status=absent"));
    expect(absent.rows).toHaveLength(1 + 12 - 3);

    const teamsCsv = await buildExport(t.db, admin, "team-checkins", new URLSearchParams("status=partial"));
    expect(teamsCsv.rows.slice(1).map((r) => [r[1], r[3], r[4], r[6], r[7]])).toEqual([["Stack Testers", 4, 3, "Partially checked in", "Deepa Sinha"]]);

    const coupons = await buildExport(t.db, admin, "coupons", new URLSearchParams("meal=snacks"));
    expect(coupons.rows.slice(1).map((r) => [r[1], r[3], r[5], r[7], r[8]])).toEqual([["snacks", "Stack Testers", "Arjun Mehta", admin.name, "issued"]]);
    const lunch = await buildExport(t.db, admin, "coupons", new URLSearchParams("meal=lunch"));
    expect(lunch.rows).toHaveLength(1);

    const summary = await buildExport(t.db, admin, "coupon-summary", new URLSearchParams());
    const row = summary.rows.find((r) => r[1] === "Stack Testers")!;
    expect(row.slice(2)).toEqual([4, 0, 4, 1, 3, 0, 4]);

    const occupancy = await buildExport(t.db, admin, "occupancy", new URLSearchParams());
    expect(occupancy.rows).toHaveLength(1 + 12);

    const volunteer = await makeActor(t.db, "organizer");
    await expectAppError(buildExport(t.db, volunteer, "registrations", new URLSearchParams()), "FORBIDDEN");
    await expectAppError(buildExport(t.db, admin, "nope", new URLSearchParams()), "NOT_FOUND");
  });
});

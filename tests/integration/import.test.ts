import { asc, eq } from "drizzle-orm";
import { expect, it } from "vitest";

import { auditLogs, distributions, teams } from "@/db/schema";
import { analyzeImport, commitImport, type ImportRequest } from "@/server/services/import";
import { issueCoupons } from "@/server/services/distribution";
import { columnOptions, describeDb, makeActor, parseCsv, readSample, SPEC_CSV, useTestDb } from "../helpers";
import { detectImportSetup } from "@/lib/csv-import";

const request = (csv: string, mode: ImportRequest["mode"] = "add_only"): ImportRequest => ({
  fileName: "teams.csv",
  table: parseCsv(csv),
  options: columnOptions,
  mode,
});

describeDb("CSV import (PostgreSQL)", () => {
  const t = useTestDb();

  it("imports a valid CSV and initialises breakfast, lunch and dinner for every team", async () => {
    const admin = await makeActor(t.db);
    const report = await commitImport(t.db, admin, request(SPEC_CSV));
    expect(report.summary).toMatchObject({ create: 3, invalidRows: 0, duplicates: 0 });

    const rows = await t.db.select().from(teams).orderBy(asc(teams.teamCode));
    expect(rows.map((r) => [r.teamCode, r.memberCount])).toEqual([
      ["T001", 4],
      ["T002", 3],
      ["T003", 5],
    ]);
    const meals = await t.db.select().from(distributions);
    expect(meals).toHaveLength(9);
    for (const team of rows) {
      const own = meals.filter((m) => m.teamId === team.id);
      expect(own.map((m) => m.mealType).sort()).toEqual(["breakfast", "dinner", "lunch"]);
      expect(own.every((m) => m.status === "pending" && m.couponQuantity === team.memberCount && m.issuedAt === null)).toBe(true);
    }
    const [log] = await t.db.select().from(auditLogs).where(eq(auditLogs.action, "csv_import"));
    expect(log.actorId).toBe(admin.id);
    expect(log.details).toMatchObject({ fileName: "teams.csv", mode: "add_only" });
  });

  it("analysis is a dry run", async () => {
    const admin = await makeActor(t.db);
    const analysis = await analyzeImport(t.db, admin, request(SPEC_CSV));
    expect(analysis.summary.create).toBe(3);
    expect(await t.db.select().from(teams)).toHaveLength(0);
  });

  it("never stores invalid rows and never duplicates existing teams", async () => {
    const admin = await makeActor(t.db);
    await commitImport(t.db, admin, request(SPEC_CSV));
    const second = [
      "team_code,team_name,team_leader_name,team_leader_email,member_count",
      "T001,Byte Builders,Aarav,aarav@example.com,6", // existing by code
      "T777,NEURAL  ninjas,Someone,s@x.com,2", // existing by name
      "T004,Bad Count,X,x@x.com,zero",
      "T005,New Team,Y,y@x.com,2",
    ].join("\n");
    const report = await commitImport(t.db, admin, request(second, "add_only"));
    expect(report.summary).toMatchObject({ create: 1, skipExisting: 2, invalidRows: 1 });
    const all = await t.db.select().from(teams).orderBy(asc(teams.teamCode));
    expect(all.map((r) => r.teamCode)).toEqual(["T001", "T002", "T003", "T005"]);
    expect(all.find((r) => r.teamCode === "T001")!.memberCount).toBe(4);
  });

  it("updates an existing team's member count before any meal is issued", async () => {
    const admin = await makeActor(t.db);
    await commitImport(t.db, admin, request(SPEC_CSV));
    const csv = SPEC_CSV.replace("Aarav,aarav@example.com,4", "Aarav,aarav@example.com,2");
    const report = await commitImport(t.db, admin, request(csv, "update_existing"));
    expect(report.summary).toMatchObject({ update: 1, unchanged: 2 });

    const [team] = await t.db.select().from(teams).where(eq(teams.teamCode, "T001"));
    expect(team.memberCount).toBe(2);
    const meals = await t.db.select().from(distributions).where(eq(distributions.teamId, team.id));
    expect(meals.every((m) => m.couponQuantity === 2)).toBe(true);
    const updates = await t.db.select().from(auditLogs).where(eq(auditLogs.action, "team_update"));
    expect(updates[0]).toMatchObject({ before: { memberCount: 4 }, after: { memberCount: 2 } });
  });

  it("refuses to change the member count by import after coupons were issued", async () => {
    const admin = await makeActor(t.db);
    await commitImport(t.db, admin, request(SPEC_CSV));
    const [team] = await t.db.select().from(teams).where(eq(teams.teamCode, "T001"));
    await issueCoupons(t.db, admin, { teamId: team.id, meal: "breakfast", expectedQuantity: 4, requestId: crypto.randomUUID() });

    const csv = SPEC_CSV.replace("Aarav,aarav@example.com,4", "Aarav,aarav@example.com,9");
    const report = await commitImport(t.db, admin, request(csv, "update_existing"));
    const t001 = report.teams.find((x) => x.teamCode === "T001")!;
    expect(t001.action).toBe("blocked");
    expect(t001.blockReason).toMatch(/already issued/);

    const [after] = await t.db.select().from(teams).where(eq(teams.id, team.id));
    expect(after.memberCount).toBe(4);
    const meals = await t.db.select().from(distributions).where(eq(distributions.teamId, team.id));
    expect(meals.every((m) => m.couponQuantity === 4)).toBe(true);
  });

  it("imports a registration export with one row per registrant", async () => {
    const admin = await makeActor(t.db);
    const table = readSample("registrations-sample.csv");
    const report = await commitImport(t.db, admin, {
      fileName: "registrations.csv",
      table,
      options: detectImportSetup(table),
      mode: "add_only",
    });
    expect(report.summary.create).toBe(10);
    expect(report.summary.excludedRows).toBe(1);
    const rows = await t.db.select().from(teams);
    expect(rows).toHaveLength(10);
    expect(await t.db.select().from(distributions)).toHaveLength(30);
  });

  it("skips teams the organizer deselected", async () => {
    const admin = await makeActor(t.db);
    const analysis = await analyzeImport(t.db, admin, request(SPEC_CSV));
    const skip = analysis.teams.find((x) => x.teamCode === "T002")!.key;
    const report = await commitImport(t.db, admin, { ...request(SPEC_CSV), skipKeys: [skip] });
    expect(report.summary).toMatchObject({ create: 2, deselected: 1 });
    expect((await t.db.select().from(teams)).map((r) => r.teamCode).sort()).toEqual(["T001", "T003"]);
  });
});

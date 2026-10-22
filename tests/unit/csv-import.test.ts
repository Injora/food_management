import { describe, expect, it } from "vitest";

import {
  buildTeamsFromTable,
  deriveTeamCode,
  detectImportSetup,
  importOptionsSchema,
  normalizeTeamKey,
  parseMemberCount,
  type ImportOptions,
} from "@/lib/csv-import";
import { columnOptions, parseCsv, readSample, SPEC_CSV } from "../helpers";

const opts = (o: Partial<ImportOptions> = {}): ImportOptions => importOptionsSchema.parse({ ...columnOptions, ...o });

describe("CSV import: valid file", () => {
  it("builds one team per row with the given member counts", () => {
    const r = buildTeamsFromTable(parseCsv(SPEC_CSV), opts());
    expect(r.invalidRows).toEqual([]);
    expect(r.rejected).toEqual([]);
    expect(r.teams.map((t) => [t.teamCode, t.teamName, t.leaderName, t.leaderEmail, t.memberCount])).toEqual([
      ["T001", "Byte Builders", "Aarav", "aarav@example.com", 4],
      ["T002", "Neural Ninjas", "Diya", "diya@example.com", 3],
      ["T003", "Code Pirates", "Rohan", "rohan@example.com", 5],
    ]);
    expect(r.teams.every((t) => t.codeSource === "csv")).toBe(true);
  });

  it("auto-detects the mapping for the documented format", () => {
    const setup = detectImportSetup(parseCsv(SPEC_CSV));
    expect(setup.mapping).toMatchObject({
      teamName: "team_name",
      teamCode: "team_code",
      leaderName: "team_leader_name",
      leaderEmail: "team_leader_email",
      memberCount: "member_count",
    });
    expect(setup.countMode).toBe("column");
    expect(setup.rowsPerTeam).toBe("one");
  });

  it("handles different column names, quoting, and missing optional fields", () => {
    const csv = `Team,Team Size,Captain\n"Rust, Inc.",3,\nAlpha Squad,2,Meera`;
    const table = parseCsv(csv);
    const setup = detectImportSetup(table);
    expect(setup.mapping).toMatchObject({ teamName: "Team", memberCount: "Team Size", leaderName: "Captain" });
    const r = buildTeamsFromTable(table, importOptionsSchema.parse(setup));
    expect(r.teams.map((t) => [t.teamName, t.teamCode, t.memberCount, t.leaderName])).toEqual([
      ["Rust, Inc.", "RUST-INC", 3, null],
      ["Alpha Squad", "ALPHA-SQUAD", 2, "Meera"],
    ]);
    expect(r.teams[0].codeSource).toBe("derived");
  });
});

describe("CSV import: invalid member counts", () => {
  it("rejects blank, non-numeric, fractional, zero, negative and oversized counts", () => {
    const csv = [
      "team_code,team_name,team_leader_name,team_leader_email,member_count",
      "A1,Valid Team,,,4",
      "A2,Blank Count,,,",
      "A3,Words,,,four",
      "A4,Fraction,,,2.5",
      "A5,Zero,,,0",
      "A6,Negative,,,-3",
      "A7,Too Big,,,11",
      "A8,Float Ok,,,3.0",
    ].join("\n");
    const r = buildTeamsFromTable(parseCsv(csv), opts());
    expect(r.teams.map((t) => [t.teamCode, t.memberCount])).toEqual([
      ["A1", 4],
      ["A8", 3],
    ]);
    expect(r.invalidRows.map((i) => [i.rowNumber, i.reason])).toEqual([
      [3, "Team size is blank"],
      [4, 'Team size "four" is not a whole number'],
      [5, 'Team size "2.5" is not a whole number'],
      [6, "Team size must be at least 1"],
      [7, 'Team size "-3" is not a whole number'],
      [8, "Team size 11 exceeds the maximum of 10"],
    ]);
  });

  it("parseMemberCount enforces the configured maximum", () => {
    expect(parseMemberCount(" 4 ", 4)).toEqual({ ok: true, value: 4 });
    expect(parseMemberCount("5", 4)).toMatchObject({ ok: false });
  });

  it("rejects rows with a blank team name", () => {
    const r = buildTeamsFromTable(parseCsv(`team_code,team_name,team_leader_name,team_leader_email,member_count\nX1,  ,,,3`), opts());
    expect(r.teams).toEqual([]);
    expect(r.invalidRows[0]).toMatchObject({ rowNumber: 2, reason: "Team name is blank" });
  });
});

describe("CSV import: duplicate teams", () => {
  it("rejects repeated codes and names (ignoring case, spacing and punctuation)", () => {
    const csv = [
      "team_code,team_name,team_leader_name,team_leader_email,member_count",
      "T001,Byte Builders,Aarav,a@x.com,4",
      "T001,Other Name,Diya,d@x.com,3",
      "T009,byte-builders,Rohan,r@x.com,2",
      "T010,Fresh Team,Ira,i@x.com,2",
    ].join("\n");
    const r = buildTeamsFromTable(parseCsv(csv), opts());
    expect(r.teams.map((t) => t.teamCode)).toEqual(["T001", "T010"]);
    expect(r.rejected).toHaveLength(2);
    expect(r.rejected[0]).toMatchObject({ kind: "duplicate", rowNumbers: [3] });
    expect(r.rejected[0].reason).toContain("Duplicate team code T001");
    expect(r.rejected[1]).toMatchObject({ kind: "duplicate", rowNumbers: [4] });
    expect(r.rejected[1].reason).toContain("Duplicate team name");
  });

  it("disambiguates derived codes that would collide", () => {
    const long = "A".repeat(40);
    const csv = `name,size\n${long}1,2\n${long}2,3`;
    const r = buildTeamsFromTable(parseCsv(csv), opts({ mapping: { teamName: "name", memberCount: "size", memberNameColumns: [] } }));
    expect(r.teams.map((t) => t.teamCode)).toEqual(["A".repeat(32), `${"A".repeat(32)}-2`]);
  });

  it("normalises names for comparison", () => {
    expect(normalizeTeamKey("  Code-Pirates! ")).toBe(normalizeTeamKey("code pirates"));
    expect(deriveTeamCode("Ctrl Alt Elite")).toBe("CTRL-ALT-ELITE");
    expect(deriveTeamCode("टीम")).toMatch(/^T-[0-9A-Z]+$/);
  });
});

describe("CSV import: one row per registrant", () => {
  it("groups registrant rows into teams and counts member-name columns", () => {
    const table = readSample("registrations-sample.csv");
    const setup = detectImportSetup(table);
    expect(setup.countMode).toBe("member_columns");
    expect(setup.rowsPerTeam).toBe("many");
    expect(setup.mapping.memberNameColumns).toEqual([
      "Team Leader Name",
      "Team Member 2 Name",
      "Team Member 3 Name",
      "Team Member 4 Name",
    ]);
    expect(setup.exclude).toEqual({ column: "status", values: ["canceled"] });

    const r = buildTeamsFromTable(table, importOptionsSchema.parse(setup));
    expect(r.excludedRows).toBe(1);
    // Every registrant of a team repeats the team form, so each group's size
    // equals its number of registrant rows (plus the one canceled row).
    const rowsPerTeam = new Map<string, number>();
    for (const row of table.rows) {
      if (row[1] === "canceled") continue;
      const k = normalizeTeamKey(row[5]);
      rowsPerTeam.set(k, (rowsPerTeam.get(k) ?? 0) + 1);
    }
    expect(r.teams).toHaveLength(10);
    for (const t of r.teams) {
      expect(t.memberCount).toBeGreaterThanOrEqual(rowsPerTeam.get(t.teamNameKey)!);
      // An upper-cased spelling of the same name must merge without a warning.
      expect(t.warnings).toEqual([]);
    }
  });

  it("warns when rows of one team disagree", () => {
    const csv = [
      "Team Name,Team Leader Name,Team Leader Email,Team Member 2 Name,Team Member 3 Name",
      "Solo Squad,Asha,asha@x.com,Ravi,",
      "Solo Squad,Asha,asha@x.com,Ravi,Kiran",
      "solo squad,Ravi,ravi@x.com,,",
    ].join("\n");
    const table = parseCsv(csv);
    const r = buildTeamsFromTable(table, importOptionsSchema.parse(detectImportSetup(table)));
    expect(r.teams).toHaveLength(1);
    expect(r.teams[0].memberCount).toBe(3);
    expect(r.teams[0].leaderEmail).toBe("asha@x.com");
    expect(r.teams[0].warnings.join(" | ")).toMatch(/different team leaders.*disagree on team size \(1, 2, 3\)/);
  });

  it("counts unique member ids when each row is one member", () => {
    const csv = "team,email\nOrbit,a@x.com\nOrbit,b@x.com\nOrbit,a@x.com\nNova,c@x.com";
    const r = buildTeamsFromTable(
      parseCsv(csv),
      opts({ mapping: { teamName: "team", memberIdColumn: "email", memberNameColumns: [] }, countMode: "unique_members", rowsPerTeam: "many" }),
    );
    expect(r.teams.map((t) => [t.teamName, t.memberCount])).toEqual([
      ["Orbit", 2],
      ["Nova", 1],
    ]);
  });
});

describe("CSV import: configuration errors", () => {
  it("requires the size column in column mode", () => {
    const res = importOptionsSchema.safeParse({ ...columnOptions, mapping: { teamName: "team_name", memberNameColumns: [] } });
    expect(res.success).toBe(false);
  });

  it("throws when a mapped column is not in the file", () => {
    expect(() => buildTeamsFromTable(parseCsv("a,b\n1,2"), opts())).toThrow(/not in the file/);
  });
});

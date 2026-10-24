import fs from "node:fs";
import { describe, expect, it } from "vitest";

import { readRegistrationFile } from "@/lib/registration-file";
import { buildTeams, detectMapping, mappingSchema, prepareTable, teamRegistrationKey } from "@/lib/registration-import";
import { parseRows, readFixture } from "../helpers";

const analyse = (name: string) => {
  const table = prepareTable(parseRows(readFixture(name)));
  const mapping = mappingSchema.parse(detectMapping(table));
  return { table, mapping, result: buildTeams(table, mapping) };
};
const messages = (r: ReturnType<typeof buildTeams>, severity?: string) =>
  r.issues.filter((i) => !severity || i.severity === severity).map((i) => i.message);

describe("one row per team, with a header row", () => {
  const { table, mapping, result } = analyse("team-rows-header.csv");

  it("detects the header and the leader/member columns", () => {
    expect(table.headerRow).toBe(0);
    expect(mapping.layout).toBe("team_row");
    expect(table.headers[mapping.teamName!]).toBe("Team Name");
    expect(table.headers[mapping.leader.name!]).toBe("Team Leader Name");
    expect(table.headers[mapping.leader.email!]).toBe("Team Leader Email");
    expect(mapping.members).toHaveLength(3);
    expect(table.headers[mapping.members[2].phone!]).toBe("Member 4 Phone");
    expect(table.headers[mapping.college!]).toBe("College / Company");
  });

  it("builds participant-level teams from named members", () => {
    const byName = new Map(result.teams.map((t) => [t.teamName, t]));
    const bb = byName.get("Byte Builders")!;
    expect(bb.members.map((m) => [m.name, m.isLeader])).toEqual([
      ["Aarav Shah", true],
      ["Diya Rao", false],
      ["Rohan Iyer", false],
      ["Isha Nair", false],
    ]);
    expect(bb.members[1]).toMatchObject({ email: "diya@example.test", phone: "+919800000001" });
    expect(byName.get("Solo Coder")!.members).toHaveLength(1);
  });

  it("merges an exact duplicate registration and reports it", () => {
    expect(result.teams.filter((t) => t.teamName === "Byte Builders")).toHaveLength(1);
    expect(messages(result, "info").some((m) => m.startsWith("Duplicate registration: row 6 repeats row 2"))).toBe(true);
  });

  it("keeps legitimate undersized teams and flags size mismatches without inventing members", () => {
    const t = result.teams.find((x) => x.teamName === "Three Of Us")!;
    expect(t.members).toHaveLength(3);
    expect(t.declaredSize).toBe(4);
    expect(messages(result, "warning")).toContain("Team size column says 4 but 3 members are listed; importing the 3 listed.");
  });

  it("imports a missing team name under a clear placeholder", () => {
    expect(result.teams.some((t) => t.teamName === "Unnamed team – Meera Pillai")).toBe(true);
    expect(messages(result, "warning").some((m) => m.startsWith('Missing team name ("(no team name given)")'))).toBe(true);
  });

  it("keeps two different teams that share a name, with a warning", () => {
    const same = result.teams.filter((t) => t.teamName === "Same Name");
    expect(same).toHaveLength(2);
    expect(new Set(same.map((t) => t.key)).size).toBe(2);
    expect(messages(result, "warning").some((m) => m.includes('2 different registrations use the team name "Same Name"'))).toBe(true);
  });

  it("flags a participant registered in two teams", () => {
    expect(messages(result, "warning").some((m) => m.startsWith("Diya Rao (diya@example.test) is registered in both"))).toBe(true);
  });

  it("reports malformed rows and skips blank ones", () => {
    expect(result.blankRows).toBe(1);
    expect(messages(result, "error")).toEqual(["Malformed row: no participant names, emails or phone numbers. Row skipped."]);
    expect(result.issues.find((i) => i.severity === "error")!.rowNumbers).toEqual([11]);
    expect(result.teams).toHaveLength(7);
  });
});

describe("one row per team, without a header row", () => {
  const { table, mapping, result } = analyse("team-rows-no-header.csv");

  it("skips the preamble and infers columns from their contents", () => {
    expect(table.headerRow).toBeNull();
    expect(table.skippedRows).toEqual([1]);
    expect(mapping).toMatchObject({ teamName: 0, declaredSize: 1, declaredRegistered: 2, college: 6 });
    // Leader phone comes before the email in this layout.
    expect(mapping.leader).toMatchObject({ name: 3, phone: 4, email: 5 });
    expect(mapping.members.map((s) => [s.name, s.email, s.phone])).toEqual([
      [7, 8, 9],
      [10, 11, 12],
      [13, 14, 15],
    ]);
  });

  it("reads every team and member with correct row numbers", () => {
    expect(result.teams.map((t) => [t.teamName, t.members.length, t.rowNumbers])).toEqual([
      ["Stack Testers", 4, [3]],
      ["Two Brain Cells", 3, [4]],
      ["Pair Programmers", 2, [5]],
      ["Late Joiners", 3, [6]],
    ]);
    const pair = result.teams[2];
    expect(pair.members[1]).toMatchObject({ name: "Ira Sethi", email: null, phone: "+919700000009" });
    expect(pair.college).toBe("Other College");
    expect(messages(result, "warning")).toContain("Team size column says 4 but 3 members are listed; importing the 3 listed.");
  });
});

describe("one row per participant", () => {
  const { table, mapping, result } = analyse("participant-rows.csv");

  it("groups rows into teams, honours the leader flag and excludes cancelled rows", () => {
    expect(mapping.layout).toBe("participant_row");
    expect(table.headers[mapping.person.externalId!]).toBe("participant_id");
    expect(mapping.exclude?.values).toEqual(["cancelled"]);
    expect(result.excludedRows).toBe(1);
    const ninjas = result.teams.find((t) => t.teamName === "Neural Ninjas")!;
    // "neural-ninjas" on another row is the same team.
    expect(ninjas.members.map((m) => [m.name, m.isLeader, m.externalId])).toEqual([
      ["Asha Verma", true, "R-001"],
      ["Bala Krishnan", false, "R-002"],
      ["Dev Arora", false, "R-004"],
    ]);
    expect(ninjas.members[0].identityKey).toBe("id:r-001");
  });

  it("keeps a participant with no name, named from their email", () => {
    const pirates = result.teams.find((t) => t.teamName === "Code Pirates")!;
    expect(pirates.members.map((m) => m.name)).toEqual(["Ekta Roy", "Firoz Khan", "gopal"]);
    expect(messages(result, "warning").some((m) => m.startsWith('A participant has no name; imported as "gopal"'))).toBe(true);
  });
});

describe("registration keys", () => {
  it("identify a registration by team name and leader", () => {
    expect(teamRegistrationKey({ teamNameKey: "alpha", leaderEmail: "a@x.y" })).toBe("team:alpha|email:a@x.y");
    expect(teamRegistrationKey({ teamNameKey: "alpha", leaderPhone: "+91 98000 00001" })).toBe("team:alpha|phone:9800000001");
    expect(teamRegistrationKey({ teamCode: "T-1", teamNameKey: "alpha", leaderEmail: "a@x.y" })).toBe("code:T-1");
  });
});

// The organiser's actual registration files are git-ignored (they contain
// personal data). When present, check they parse exactly as reviewed.
const real = [
  { file: "Hack Day Team - Sheet10.csv", teams: 14, participants: 50 },
  { file: "Hack Day Team - Sheet11.csv", teams: 97, participants: 282 },
].filter((f) => fs.existsSync(f.file));

describe.skipIf(real.length === 0)("the supplied registration files", () => {
  it.each(real)("$file → $teams teams, $participants participants, no errors", async ({ file, teams, participants }) => {
    const [sheet] = await readRegistrationFile(file, new Uint8Array(fs.readFileSync(file)));
    const table = prepareTable(sheet.rows);
    const result = buildTeams(table, mappingSchema.parse(detectMapping(table)));
    expect(result.teams).toHaveLength(teams);
    expect(result.teams.reduce((n, t) => n + t.members.length, 0)).toBe(participants);
    expect(result.issues.filter((i) => i.severity === "error")).toEqual([]);
    expect(result.teams.every((t) => t.members.filter((m) => m.isLeader).length === 1)).toBe(true);
  });
});

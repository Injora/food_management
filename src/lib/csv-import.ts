import { z } from "zod";

/**
 * Pure CSV-to-teams logic. It runs on the server for validation and import;
 * the client only uses the column auto-detection for the mapping form.
 */

export const MAX_IMPORT_ROWS = 50_000;
export const DEFAULT_MAX_TEAM_SIZE = 10;

export const columnMappingSchema = z.object({
  teamName: z.string().min(1, "Map the team name column"),
  teamCode: z.string().min(1).nullish(),
  leaderName: z.string().min(1).nullish(),
  leaderEmail: z.string().min(1).nullish(),
  memberCount: z.string().min(1).nullish(),
  memberNameColumns: z.array(z.string().min(1)).max(50).default([]),
  memberIdColumn: z.string().min(1).nullish(),
});
export type ColumnMapping = z.infer<typeof columnMappingSchema>;

export const importOptionsSchema = z
  .object({
    mapping: columnMappingSchema,
    /**
     * column:          a team size column
     * member_columns:  count non-blank member name columns on each row
     * unique_members:  one row per member; count distinct member ids per team
     */
    countMode: z.enum(["column", "member_columns", "unique_members"]),
    /** many = the same team appears on several rows and should be merged. */
    rowsPerTeam: z.enum(["one", "many"]),
    groupBy: z.enum(["team_code", "team_name", "leader_email"]).default("team_name"),
    exclude: z
      .object({ column: z.string().min(1), values: z.array(z.string()).max(200) })
      .nullish(),
    maxTeamSize: z.number().int().min(1).max(1000).default(DEFAULT_MAX_TEAM_SIZE),
  })
  .superRefine((o, ctx) => {
    const m = o.mapping;
    if (o.countMode === "column" && !m.memberCount) {
      ctx.addIssue({ code: "custom", message: "Map the team size column", path: ["mapping", "memberCount"] });
    }
    if (o.countMode === "member_columns" && m.memberNameColumns.length === 0) {
      ctx.addIssue({ code: "custom", message: "Select at least one member name column", path: ["mapping", "memberNameColumns"] });
    }
    if (o.countMode === "unique_members") {
      if (!m.memberIdColumn) {
        ctx.addIssue({ code: "custom", message: "Map the member identifier column", path: ["mapping", "memberIdColumn"] });
      }
      if (o.rowsPerTeam !== "many") {
        ctx.addIssue({ code: "custom", message: "Counting members per row requires grouping rows by team", path: ["rowsPerTeam"] });
      }
    }
    if (o.rowsPerTeam === "many" && o.groupBy === "team_code" && !m.teamCode) {
      ctx.addIssue({ code: "custom", message: "Map the team code column to group by it", path: ["groupBy"] });
    }
    if (o.rowsPerTeam === "many" && o.groupBy === "leader_email" && !m.leaderEmail) {
      ctx.addIssue({ code: "custom", message: "Map the leader email column to group by it", path: ["groupBy"] });
    }
  });
export type ImportOptions = z.infer<typeof importOptionsSchema>;
export type ImportOptionsInput = z.input<typeof importOptionsSchema>;

export const parsedTableSchema = z
  .object({
    headers: z.array(z.string()).min(1).max(500),
    rows: z.array(z.array(z.string())).max(MAX_IMPORT_ROWS),
  })
  .refine((t) => new Set(t.headers).size === t.headers.length, "Column names must be unique");
export type ParsedTable = z.infer<typeof parsedTableSchema>;

export type RowIssue = { rowNumber: number; teamName: string | null; reason: string };

export type RejectedTeam = {
  kind: "duplicate" | "invalid";
  teamName: string;
  teamCode: string | null;
  rowNumbers: number[];
  reason: string;
};

export type CandidateTeam = {
  /** Stable identifier of this team within the file (used to deselect teams). */
  key: string;
  teamName: string;
  teamNameKey: string;
  teamCode: string;
  codeSource: "csv" | "derived";
  leaderName: string | null;
  leaderEmail: string | null;
  memberCount: number;
  rowNumbers: number[];
  warnings: string[];
};

export type BuildResult = {
  totalRows: number;
  blankRows: number;
  excludedRows: number;
  invalidRows: RowIssue[];
  rejected: RejectedTeam[];
  teams: CandidateTeam[];
};

// ---------------------------------------------------------------------------
// Normalisation
// ---------------------------------------------------------------------------

/** Trim, NFKC-normalise and collapse whitespace. Empty becomes null. */
export function cleanText(value: string | null | undefined): string | null {
  if (value == null) return null;
  const t = value.normalize("NFKC").replace(/\s+/g, " ").trim();
  return t.length > 0 ? t : null;
}

/** Key used to detect the same team spelled differently ("Code-Pirates" = "code pirates"). */
export function normalizeTeamKey(name: string): string {
  return name.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

export function normalizeTeamCode(code: string | null | undefined): string | null {
  const t = cleanText(code);
  return t ? t.toUpperCase().replace(/\s+/g, "-") : null;
}

export function normalizeEmail(email: string | null | undefined): string | null {
  const t = cleanText(email);
  return t ? t.toLowerCase() : null;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export function looksLikeEmail(email: string): boolean {
  return EMAIL_RE.test(email);
}

function fnv1a(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Readable, deterministic team code derived from the team name. */
export function deriveTeamCode(name: string): string {
  const slug = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32)
    .replace(/-+$/, "");
  if (slug) return slug;
  return `T-${fnv1a(normalizeTeamKey(name)).toString(36).toUpperCase()}`;
}

/** Strictly parses a positive whole number. Returns an error message on failure. */
export function parseMemberCount(
  raw: string | null | undefined,
  maxTeamSize: number,
): { ok: true; value: number } | { ok: false; reason: string } {
  const t = cleanText(raw);
  if (!t) return { ok: false, reason: "Team size is blank" };
  if (!/^\d+(\.0+)?$/.test(t)) return { ok: false, reason: `Team size "${t}" is not a whole number` };
  const value = Number.parseInt(t, 10);
  if (value < 1) return { ok: false, reason: "Team size must be at least 1" };
  if (value > maxTeamSize) {
    return { ok: false, reason: `Team size ${value} exceeds the maximum of ${maxTeamSize}` };
  }
  return { ok: true, value };
}

// ---------------------------------------------------------------------------
// Column auto-detection
// ---------------------------------------------------------------------------

const headerKey = (h: string) => h.toLowerCase().replace(/[^a-z0-9]+/g, "");

const SYNONYMS = {
  teamName: ["teamname", "team", "nameofteam", "groupname", "squadname", "teamtitle"],
  teamCode: ["teamcode", "teamid", "teamno", "teamnumber", "code", "teamref", "teamreference"],
  leaderName: ["teamleadername", "leadername", "teamleader", "leader", "captain", "captainname", "teamlead", "teamleadname"],
  leaderEmail: ["teamleaderemail", "leaderemail", "captainemail", "teamleademail", "leademail", "leaderemailaddress", "teamleaderemailaddress"],
  memberCount: ["membercount", "teamsize", "size", "members", "noofmembers", "numberofmembers", "nummembers", "participants", "participantcount", "headcount", "count", "totalmembers"],
  memberId: ["email", "emailaddress", "memberemail", "participantemail", "registrantemail", "memberid", "participantid"],
  status: ["status", "registrationstatus", "attendeestatus", "ticketstatus"],
} as const;

const EXCLUDED_STATUS_VALUES = ["canceled", "cancelled", "withdrawn", "rejected", "declined", "refunded"];

function findColumn(headers: string[], synonyms: readonly string[]): string | null {
  const keys = headers.map(headerKey);
  for (const s of synonyms) {
    const i = keys.indexOf(s);
    if (i !== -1) return headers[i];
  }
  return null;
}

export type DetectedSetup = Omit<ImportOptions, "maxTeamSize"> & { maxTeamSize: number };

/** Best-effort guess of the import configuration from headers and data. */
export function detectImportSetup(table: ParsedTable): DetectedSetup {
  const { headers, rows } = table;
  const teamName = findColumn(headers, SYNONYMS.teamName) ?? headers[0];
  const teamCode = findColumn(headers, SYNONYMS.teamCode);
  const leaderName = findColumn(headers, SYNONYMS.leaderName);
  const leaderEmail = findColumn(headers, SYNONYMS.leaderEmail);
  const memberCount = findColumn(headers, SYNONYMS.memberCount);
  const memberIdColumn = findColumn(headers, SYNONYMS.memberId);

  // "Team Member 2 Name", "Member 3", "Participant 4 Name" (plus the leader).
  const memberNameColumns = headers.filter((h) => {
    const k = h.toLowerCase();
    return /(member|participant)\s*#?\s*\d+/.test(k) && !/(email|phone|mobile|college|company|contact|id\b|github|linkedin|role)/.test(k);
  });
  if (memberNameColumns.length > 0 && leaderName && !memberNameColumns.includes(leaderName)) {
    memberNameColumns.unshift(leaderName);
  }

  const nameIdx = headers.indexOf(teamName);
  const keys = rows.map((r) => normalizeTeamKey(r[nameIdx] ?? "")).filter(Boolean);
  const repeated = new Set(keys).size < keys.length;

  let countMode: ImportOptions["countMode"];
  if (memberCount) countMode = "column";
  else if (memberNameColumns.length > 0) countMode = "member_columns";
  else if (memberIdColumn && repeated) countMode = "unique_members";
  else countMode = "column";

  const statusColumn = findColumn(headers, SYNONYMS.status);
  let exclude: ImportOptions["exclude"] = null;
  if (statusColumn) {
    const idx = headers.indexOf(statusColumn);
    const present = new Set(rows.map((r) => (cleanText(r[idx]) ?? "").toLowerCase()));
    const values = EXCLUDED_STATUS_VALUES.filter((v) => present.has(v));
    exclude = { column: statusColumn, values };
  }

  return {
    mapping: { teamName, teamCode, leaderName, leaderEmail, memberCount, memberNameColumns, memberIdColumn },
    countMode,
    rowsPerTeam: repeated || countMode === "unique_members" ? "many" : "one",
    groupBy: "team_name",
    exclude,
    maxTeamSize: DEFAULT_MAX_TEAM_SIZE,
  };
}

// ---------------------------------------------------------------------------
// Rows -> candidate teams
// ---------------------------------------------------------------------------

type ParsedRow = {
  rowNumber: number;
  name: string;
  nameKey: string;
  code: string | null;
  leaderName: string | null;
  leaderEmail: string | null;
  count: number | null;
  memberId: string | null;
};

function mostFrequent<T>(values: T[]): T | null {
  const counts = new Map<T, number>();
  let best: T | null = null;
  let bestCount = 0;
  for (const v of values) {
    const c = (counts.get(v) ?? 0) + 1;
    counts.set(v, c);
    // Strictly greater keeps the first-seen value on ties.
    if (c > bestCount) {
      best = v;
      bestCount = c;
    }
  }
  return best;
}

function distinct<T>(values: (T | null)[]): T[] {
  return [...new Set(values.filter((v): v is T => v != null))];
}

/** Header row is line 1, so data row i is line i + 2 in the file. */
const lineNumber = (rowIndex: number) => rowIndex + 2;

export function buildTeamsFromTable(table: ParsedTable, options: ImportOptions): BuildResult {
  const { headers, rows } = table;
  const { mapping, countMode, maxTeamSize } = options;

  const col = (name: string | null | undefined) => {
    if (!name) return -1;
    const i = headers.indexOf(name);
    if (i === -1) throw new Error(`Column "${name}" is not in the file`);
    return i;
  };
  const nameIdx = col(mapping.teamName);
  const codeIdx = col(mapping.teamCode);
  const leaderNameIdx = col(mapping.leaderName);
  const leaderEmailIdx = col(mapping.leaderEmail);
  const countIdx = countMode === "column" ? col(mapping.memberCount) : -1;
  const memberIdx = countMode === "member_columns" ? mapping.memberNameColumns.map((c) => col(c)) : [];
  const memberIdIdx = countMode === "unique_members" ? col(mapping.memberIdColumn) : -1;
  const excludeIdx = options.exclude && options.exclude.values.length > 0 ? col(options.exclude.column) : -1;
  const excludeValues = new Set((options.exclude?.values ?? []).map((v) => v.trim().toLowerCase()));

  const cell = (row: string[], idx: number) => (idx >= 0 ? cleanText(row[idx]) : null);

  const result: BuildResult = {
    totalRows: rows.length,
    blankRows: 0,
    excludedRows: 0,
    invalidRows: [],
    rejected: [],
    teams: [],
  };

  const parsed: ParsedRow[] = [];
  rows.forEach((row, i) => {
    const rowNumber = lineNumber(i);
    if (row.every((v) => cleanText(v) === null)) {
      result.blankRows++;
      return;
    }
    if (excludeIdx >= 0 && excludeValues.has((cell(row, excludeIdx) ?? "").toLowerCase())) {
      result.excludedRows++;
      return;
    }
    const name = cell(row, nameIdx);
    if (!name) {
      result.invalidRows.push({ rowNumber, teamName: null, reason: "Team name is blank" });
      return;
    }
    const nameKey = normalizeTeamKey(name);
    if (!nameKey) {
      result.invalidRows.push({ rowNumber, teamName: name, reason: "Team name has no letters or digits" });
      return;
    }
    if (name.length > 120) {
      result.invalidRows.push({ rowNumber, teamName: name.slice(0, 40) + "…", reason: "Team name is longer than 120 characters" });
      return;
    }

    let count: number | null = null;
    let memberId: string | null = null;
    if (countMode === "column") {
      const parsedCount = parseMemberCount(row[countIdx], maxTeamSize);
      if (!parsedCount.ok) {
        result.invalidRows.push({ rowNumber, teamName: name, reason: parsedCount.reason });
        return;
      }
      count = parsedCount.value;
    } else if (countMode === "member_columns") {
      const members = new Set(
        memberIdx.map((idx) => cell(row, idx)?.toLowerCase()).filter((v): v is string => !!v),
      );
      if (members.size === 0) {
        result.invalidRows.push({ rowNumber, teamName: name, reason: "No member names in the member columns" });
        return;
      }
      if (members.size > maxTeamSize) {
        result.invalidRows.push({ rowNumber, teamName: name, reason: `${members.size} members exceeds the maximum of ${maxTeamSize}` });
        return;
      }
      count = members.size;
    } else {
      memberId = cell(row, memberIdIdx)?.toLowerCase() ?? null;
      if (!memberId) {
        result.invalidRows.push({ rowNumber, teamName: name, reason: "Member identifier is blank" });
        return;
      }
    }

    const leaderEmail = normalizeEmail(leaderEmailIdx >= 0 ? row[leaderEmailIdx] : null);
    parsed.push({
      rowNumber,
      name,
      nameKey,
      code: codeIdx >= 0 ? normalizeTeamCode(row[codeIdx]) : null,
      leaderName: cell(row, leaderNameIdx),
      leaderEmail,
      count,
      memberId,
    });
  });

  const candidates: CandidateTeam[] =
    options.rowsPerTeam === "one" ? singleRowTeams(parsed, result) : groupedTeams(parsed, options, result);

  dedupeCandidates(candidates, result);
  return result;
}

function toCandidate(rows: ParsedRow[], memberCount: number, warnings: string[]): CandidateTeam {
  const teamName = mostFrequent(rows.map((r) => r.name))!;
  const code = mostFrequent(rows.map((r) => r.code).filter((c): c is string => !!c));
  const leaderEmail = mostFrequent(rows.map((r) => r.leaderEmail).filter((v): v is string => !!v));
  const leaderName = mostFrequent(rows.map((r) => r.leaderName).filter((v): v is string => !!v));
  if (leaderEmail && !looksLikeEmail(leaderEmail)) {
    warnings.push(`Leader email "${leaderEmail}" does not look like an email address`);
  }
  return {
    key: "",
    teamName,
    teamNameKey: normalizeTeamKey(teamName),
    teamCode: code ?? deriveTeamCode(teamName),
    codeSource: code ? "csv" : "derived",
    leaderName,
    leaderEmail,
    memberCount,
    rowNumbers: rows.map((r) => r.rowNumber),
    warnings,
  };
}

function singleRowTeams(parsed: ParsedRow[], result: BuildResult): CandidateTeam[] {
  const byCode = new Map<string, number>();
  const byKey = new Map<string, number>();
  const teams: CandidateTeam[] = [];
  for (const row of parsed) {
    const codeSeen = row.code ? byCode.get(row.code) : undefined;
    const keySeen = byKey.get(row.nameKey);
    if (codeSeen !== undefined || keySeen !== undefined) {
      const reason =
        codeSeen !== undefined
          ? `Duplicate team code ${row.code} (first seen on row ${codeSeen})`
          : `Duplicate team name (first seen on row ${keySeen})`;
      result.rejected.push({ kind: "duplicate", teamName: row.name, teamCode: row.code, rowNumbers: [row.rowNumber], reason });
      continue;
    }
    if (row.code) byCode.set(row.code, row.rowNumber);
    byKey.set(row.nameKey, row.rowNumber);
    teams.push(toCandidate([row], row.count!, []));
  }
  return teams;
}

function groupedTeams(parsed: ParsedRow[], options: ImportOptions, result: BuildResult): CandidateTeam[] {
  const groups = new Map<string, ParsedRow[]>();
  for (const row of parsed) {
    let key: string | null;
    if (options.groupBy === "team_code") key = row.code;
    else if (options.groupBy === "leader_email") key = row.leaderEmail;
    else key = row.nameKey;
    if (!key) {
      const what = options.groupBy === "team_code" ? "Team code" : "Leader email";
      result.invalidRows.push({ rowNumber: row.rowNumber, teamName: row.name, reason: `${what} is blank, so the row can't be grouped` });
      continue;
    }
    const list = groups.get(key);
    if (list) list.push(row);
    else groups.set(key, [row]);
  }

  const teams: CandidateTeam[] = [];
  for (const rows of groups.values()) {
    const warnings: string[] = [];
    const names = distinct(rows.map((r) => r.name));
    if (new Set(rows.map((r) => r.nameKey)).size > 1) {
      warnings.push(`Rows use different team names: ${names.join(", ")}`);
    }
    const codes = distinct(rows.map((r) => r.code));
    if (codes.length > 1) warnings.push(`Rows list different team codes: ${codes.join(", ")}`);
    const emails = distinct(rows.map((r) => r.leaderEmail));
    if (emails.length > 1) warnings.push(`Rows list different team leaders: ${emails.join(", ")}`);

    let memberCount: number;
    if (options.countMode === "unique_members") {
      memberCount = new Set(rows.map((r) => r.memberId)).size;
      if (memberCount > options.maxTeamSize) {
        result.rejected.push({
          kind: "invalid",
          teamName: rows[0].name,
          teamCode: codes[0] ?? null,
          rowNumbers: rows.map((r) => r.rowNumber),
          reason: `${memberCount} members exceeds the maximum of ${options.maxTeamSize}`,
        });
        continue;
      }
    } else {
      const counts = rows.map((r) => r.count!);
      memberCount = Math.max(...counts);
      const unique = [...new Set(counts)].sort((a, b) => a - b);
      if (unique.length > 1) {
        warnings.push(`Rows disagree on team size (${unique.join(", ")}); using the largest (${memberCount})`);
      }
    }
    teams.push(toCandidate(rows, memberCount, warnings));
  }
  return teams;
}

/** Rejects later teams that collide on name or CSV code; disambiguates derived codes. */
function dedupeCandidates(candidates: CandidateTeam[], result: BuildResult) {
  const nameOwner = new Map<string, CandidateTeam>();
  const codeOwner = new Map<string, CandidateTeam>();
  const accepted: CandidateTeam[] = [];

  // Teams with codes from the file claim them first, so derived codes never
  // steal a real code that appears later in the file.
  const csvCodes = new Set(candidates.filter((c) => c.codeSource === "csv").map((c) => c.teamCode));

  for (const team of candidates) {
    const sameName = nameOwner.get(team.teamNameKey);
    if (sameName) {
      result.rejected.push({
        kind: "duplicate",
        teamName: team.teamName,
        teamCode: team.codeSource === "csv" ? team.teamCode : null,
        rowNumbers: team.rowNumbers,
        reason: `Duplicate team name: "${sameName.teamName}" is already on rows ${sameName.rowNumbers.join(", ")}`,
      });
      continue;
    }
    if (team.codeSource === "csv") {
      const sameCode = codeOwner.get(team.teamCode);
      if (sameCode) {
        result.rejected.push({
          kind: "duplicate",
          teamName: team.teamName,
          teamCode: team.teamCode,
          rowNumbers: team.rowNumbers,
          reason: `Duplicate team code ${team.teamCode}: already used by "${sameCode.teamName}"`,
        });
        continue;
      }
    } else {
      const base = team.teamCode;
      let n = 2;
      while (codeOwner.has(team.teamCode) || csvCodes.has(team.teamCode)) {
        team.teamCode = `${base}-${n++}`;
      }
    }
    nameOwner.set(team.teamNameKey, team);
    codeOwner.set(team.teamCode, team);
    team.key = team.teamNameKey;
    accepted.push(team);
  }
  result.teams = accepted;
}

import { z } from "zod";

/**
 * Pure registration-file logic, shared by the browser (preview and mapping
 * suggestions) and the server (which re-runs it on every validate/import and
 * never trusts the client's analysis).
 *
 * Supported layouts:
 *   team_row         one row per team, with leader and numbered member columns
 *   participant_row  one row per participant, grouped into teams by team code,
 *                    leader email or team name
 * Files with or without a header row are supported; preamble lines before the
 * data (titles, notes, blank lines) are skipped and reported.
 */

export const MAX_IMPORT_ROWS = 20_000;
export const DEFAULT_MAX_TEAM_SIZE = 10;
const MAX_MEMBER_SLOTS = 20;

// ---------------------------------------------------------------------------
// Normalisation
// ---------------------------------------------------------------------------

/** Trim, NFKC-normalise and collapse whitespace. Empty becomes null. */
export function cleanText(value: string | null | undefined): string | null {
  if (value == null) return null;
  const t = value.normalize("NFKC").replace(/\s+/g, " ").trim();
  return t.length > 0 ? t : null;
}

/** Case/space/punctuation-insensitive key ("Code-Pirates" = "code pirates"). */
export function normalizeKey(name: string): string {
  return name.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

export function normalizeEmail(email: string | null | undefined): string | null {
  const t = cleanText(email);
  return t ? t.toLowerCase() : null;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const looksLikeEmail = (v: string) => EMAIL_RE.test(v);

/** Digits only; phone numbers are compared on their last 10 digits. */
export function normalizePhone(phone: string | null | undefined): string | null {
  const t = cleanText(phone);
  if (!t) return null;
  const digits = t.replace(/\D/g, "");
  return digits.length >= 6 ? digits : null;
}
/** Accepts raw or normalised phone numbers. */
const phoneMatchKey = (phone: string) => (normalizePhone(phone) ?? phone.replace(/\D/g, "")).slice(-10);

const looksLikePhone = (v: string) => /^\+?[\d\s\-().]{7,}$/.test(v) && v.replace(/\D/g, "").length >= 7;
const looksLikeSmallInt = (v: string) => /^\d{1,3}(\.0+)?$/.test(v);

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
  return slug || `T-${fnv1a(normalizeKey(name)).toString(36).toUpperCase()}`;
}

export function normalizeTeamCode(code: string | null | undefined): string | null {
  const t = cleanText(code);
  return t ? t.toUpperCase().replace(/\s+/g, "-") : null;
}

/** Matching key of a participant within a team. */
export function participantIdentity(p: { externalId?: string | null; email?: string | null; phone?: string | null; name: string }): string {
  if (p.externalId) return `id:${p.externalId.toLowerCase()}`;
  if (p.email) return `email:${p.email}`;
  if (p.phone && normalizePhone(p.phone)) return `phone:${phoneMatchKey(p.phone)}`;
  return `name:${normalizeKey(p.name)}`;
}

/**
 * Identity of a registration across imports: the team name plus the leader
 * (email, else phone, else name), or the team code when the file has one.
 * Two different teams that happen to share a name stay separate.
 */
export function teamRegistrationKey(t: {
  teamCode?: string | null;
  teamNameKey: string;
  leaderEmail?: string | null;
  leaderPhone?: string | null;
  leaderName?: string | null;
}): string {
  if (t.teamCode) return `code:${t.teamCode}`;
  const leader = t.leaderEmail
    ? `email:${t.leaderEmail}`
    : t.leaderPhone
      ? `phone:${phoneMatchKey(t.leaderPhone)}`
      : t.leaderName
        ? `name:${normalizeKey(t.leaderName)}`
        : "none";
  return `team:${t.teamNameKey}|${leader}`;
}

const PLACEHOLDER_NAMES = new Set(
  ["-", "--", "na", "n/a", "none", "null", "nil", "tbd", "tba", "no team name given", "no team name", "no name", "not applicable", "unnamed"].map(
    (s) => s.replace(/[^a-z0-9/ -]/g, ""),
  ),
);
export function isPlaceholderName(name: string): boolean {
  const k = name.toLowerCase().replace(/[()[\]"'.]/g, "").trim();
  return PLACEHOLDER_NAMES.has(k);
}

// ---------------------------------------------------------------------------
// Table preparation: header and preamble detection
// ---------------------------------------------------------------------------

export type PreparedTable = {
  /** Index of the header row in the raw rows, or null when the file has none. */
  headerRow: number | null;
  headers: string[];
  /** Data rows with their 1-based row number in the original file. */
  rows: { rowNumber: number; cells: string[] }[];
  /** 1-based row numbers of preamble lines skipped above the data. */
  skippedRows: number[];
};

const HEADER_WORDS = /\b(team|name|email|e-mail|mail|phone|mobile|member|leader|captain|college|company|count|size|id|participant|institute|university|status|role|contact)\b/i;

const nonEmpty = (row: string[]) => row.filter((c) => cleanText(c) !== null).length;

function looksLikeHeader(row: string[]): boolean {
  const cells = row.map((c) => cleanText(c)).filter((c): c is string => c !== null);
  if (cells.length < 2) return false;
  if (cells.some((c) => looksLikeEmail(c) || looksLikePhone(c))) return false;
  const wordy = cells.filter((c) => HEADER_WORDS.test(c.replace(/[_/]/g, " "))).length;
  return wordy >= 2 && wordy / cells.length >= 0.3;
}

/**
 * Finds the header row (if any) among the first non-blank lines and drops
 * preamble lines. `headerRow` forces a choice: a row index, or null for "no
 * header row".
 */
export function prepareTable(raw: string[][], opts: { headerRow?: number | null } = {}): PreparedTable {
  const width = Math.max(0, ...raw.map((r) => r.length));
  const pad = (r: string[]) => (r.length < width ? [...r, ...Array<string>(width - r.length).fill("")] : r);

  let headerRow: number | null;
  if (opts.headerRow !== undefined) {
    headerRow = opts.headerRow;
  } else {
    headerRow = null;
    let inspected = 0;
    for (let i = 0; i < raw.length && inspected < 10; i++) {
      if (nonEmpty(raw[i]) === 0) continue;
      inspected++;
      if (looksLikeHeader(raw[i])) {
        headerRow = i;
        break;
      }
      // Real data reached before any header: the file has no header row.
      if (nonEmpty(raw[i]) >= 3) break;
    }
  }

  const skippedRows: number[] = [];
  let start = headerRow === null ? 0 : headerRow + 1;
  if (headerRow === null) {
    // Lines with fewer than 2 filled cells above the data are titles or notes.
    while (start < raw.length && nonEmpty(raw[start]) < 2) {
      if (nonEmpty(raw[start]) > 0) skippedRows.push(start + 1);
      start++;
    }
  } else {
    for (let i = 0; i < headerRow; i++) if (nonEmpty(raw[i]) > 0) skippedRows.push(i + 1);
  }

  const seen = new Map<string, number>();
  const headers = Array.from({ length: width }, (_, i) => {
    const base = (headerRow !== null ? cleanText(raw[headerRow][i]?.replace(/^﻿/, "")) : null) ?? `Column ${i + 1}`;
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return n === 1 ? base : `${base} (${n})`;
  });

  const rows: PreparedTable["rows"] = [];
  for (let i = start; i < raw.length; i++) rows.push({ rowNumber: i + 1, cells: pad(raw[i]) });
  return { headerRow, headers, rows, skippedRows };
}

// ---------------------------------------------------------------------------
// Mapping
// ---------------------------------------------------------------------------

const col = z.number().int().min(0).max(999).nullable().default(null);

export const slotSchema = z.object({
  name: col,
  lastName: col,
  email: col,
  phone: col,
  externalId: col,
});
export type Slot = z.infer<typeof slotSchema>;
export const emptySlot = (): Slot => ({ name: null, lastName: null, email: null, phone: null, externalId: null });

/** Shape and defaults only; `mappingSchema` adds the completeness checks. */
export const mappingBaseSchema = z.object({
  layout: z.enum(["team_row", "participant_row"]),
  teamName: col,
  teamCode: col,
  college: col,
  declaredSize: col,
  declaredRegistered: col,
  /** team_row: the leader's columns. participant_row: columns naming the team's leader. */
  leader: slotSchema.default(emptySlot),
  /** team_row: one slot per member position. */
  members: z.array(slotSchema).max(MAX_MEMBER_SLOTS).default([]),
  /** participant_row: the person on this row. */
  person: slotSchema.default(emptySlot),
  /** participant_row: a column marking the leader (leader / captain / yes). */
  role: col,
  exclude: z.object({ column: z.number().int().min(0), values: z.array(z.string().max(100)).max(50) }).nullable().default(null),
  maxTeamSize: z.number().int().min(1).max(100).default(DEFAULT_MAX_TEAM_SIZE),
});

export const mappingSchema = mappingBaseSchema.superRefine((m, ctx) => {
  if (m.teamName === null) ctx.addIssue({ code: "custom", message: "Map the team name column", path: ["teamName"] });
  if (m.layout === "team_row" && m.leader.name === null && m.members.every((s) => s.name === null)) {
    ctx.addIssue({ code: "custom", message: "Map the leader or member name columns", path: ["leader"] });
  }
  if (m.layout === "participant_row" && m.person.name === null) {
    ctx.addIssue({ code: "custom", message: "Map the participant name column", path: ["person"] });
  }
});
export type Mapping = z.infer<typeof mappingSchema>;
export type MappingInput = z.input<typeof mappingSchema>;

const headerKey = (h: string) => h.toLowerCase().replace(/[^a-z0-9]+/g, "");

type FieldKind = keyof Slot;
function personField(header: string): FieldKind | null {
  const k = header.toLowerCase();
  if (/(e-?mail|mail id)/.test(k)) return "email";
  if (/(phone|mobile|contact|whats ?app|cell)/.test(k)) return "phone";
  if (/(last ?name|surname)/.test(k)) return "lastName";
  if (/\b(id|roll|reg(istration)? ?(no|number|id))\b/.test(k) && !/team/.test(k)) return "externalId";
  if (/(college|company|github|linkedin|gender|size|age|year|branch|degree|role|t-?shirt|city|state|country|institute|university|organi[sz]ation)/.test(k)) return null;
  return "name";
}

const EXCLUDED_STATUS_VALUES = ["canceled", "cancelled", "withdrawn", "rejected", "declined", "refunded", "not attending"];

function detectFromHeaders(table: PreparedTable): MappingInput {
  const headers = table.headers;
  const keys = headers.map(headerKey);
  const find = (pred: (k: string) => boolean) => {
    const i = keys.findIndex(pred);
    return i === -1 ? null : i;
  };

  const teamName = find((k) => ["teamname", "team", "nameofteam", "groupname", "squadname", "teamtitle"].includes(k)) ?? find((k) => k.includes("teamname"));
  const teamCode = find((k) => ["teamcode", "teamid", "teamno", "teamnumber", "teamref"].includes(k));
  const college = find((k) => /(college|company|institute|university|organi[sz]ation|school)/.test(k));
  const declaredSize = find((k) =>
    ["membercount", "teamsize", "size", "noofmembers", "numberofmembers", "nummembers", "participantcount", "headcount", "totalmembers", "members"].includes(k),
  );
  const declaredRegistered = find((k) => k.startsWith("registered") && k !== "registeredat" && k !== "registeredon");

  const leader = emptySlot();
  const memberSlots = new Map<number, Slot>();
  headers.forEach((h, i) => {
    const lower = h.toLowerCase();
    if (/(leader|captain|team ?lead)/.test(lower)) {
      const f = personField(lower.replace(/(team )?(leader|captain|lead)/, ""));
      if (f && leader[f] === null) leader[f] = i;
      return;
    }
    const m = lower.match(/(?:member|participant|teammate|player)\s*#?\s*(\d+)/);
    if (m) {
      const f = personField(lower.replace(m[0], ""));
      if (!f) return;
      const n = Number(m[1]);
      const slot = memberSlots.get(n) ?? emptySlot();
      if (slot[f] === null) slot[f] = i;
      memberSlots.set(n, slot);
    }
  });
  const members = [...memberSlots.entries()].sort((a, b) => a[0] - b[0]).map(([, s]) => s);

  // One row per participant: a person name column but no numbered member columns.
  const person = emptySlot();
  if (members.length === 0) {
    person.name = find((k) => ["name", "fullname", "participantname", "membername", "attendeename", "firstname", "registrantname"].includes(k));
    person.lastName = find((k) => ["lastname", "surname"].includes(k));
    person.email = find((k) => ["email", "emailaddress", "participantemail", "memberemail", "attendeeemail"].includes(k));
    person.phone = find((k) => ["phone", "phonenumber", "mobile", "mobilenumber", "contact", "contactnumber"].includes(k));
    person.externalId = find((k) => ["participantid", "memberid", "attendeeid", "registrationid", "id", "ticketid"].includes(k));
  }
  const layout = members.length === 0 && person.name !== null ? "participant_row" : "team_row";
  const role = layout === "participant_row" ? find((k) => ["role", "isleader", "leader", "captain", "position"].includes(k)) : null;
  const status = find((k) => ["status", "registrationstatus", "attendeestatus", "ticketstatus"].includes(k));

  return {
    layout,
    teamName,
    teamCode,
    college,
    declaredSize,
    declaredRegistered,
    leader,
    members,
    person,
    role,
    exclude:
      status === null
        ? null
        : {
            column: status,
            values: EXCLUDED_STATUS_VALUES.filter((v) => table.rows.some((r) => (cleanText(r.cells[status]) ?? "").toLowerCase() === v)),
          },
  };
}

type ColumnKind = "email" | "phone" | "int" | "text" | "empty";

function profileColumns(table: PreparedTable): ColumnKind[] {
  return table.headers.map((_, c) => {
    const values = table.rows.map((r) => cleanText(r.cells[c])).filter((v): v is string => v !== null);
    if (values.length === 0) return "empty";
    const share = (pred: (v: string) => boolean) => values.filter(pred).length / values.length;
    if (share(looksLikeEmail) >= 0.6) return "email";
    if (share(looksLikePhone) >= 0.6) return "phone";
    if (share(looksLikeSmallInt) >= 0.8) return "int";
    return "text";
  });
}

/**
 * Without a header row, infer the layout from cell contents: team name, then
 * counts, then the leader (a name followed by contact columns), an
 * institution column, and repeating member groups (name, email, phone).
 */
function detectFromContents(table: PreparedTable): MappingInput {
  const kinds = profileColumns(table);
  const isContact = (i: number) => kinds[i] === "email" || kinds[i] === "phone";
  const mapping: MappingInput = { layout: "team_row", teamName: null, college: null, declaredSize: null, declaredRegistered: null, leader: emptySlot(), members: [] };
  const members: Slot[] = [];
  let leaderDone = false;

  for (let i = 0; i < kinds.length; i++) {
    const kind = kinds[i];
    if (kind === "empty") continue;
    if (mapping.teamName === null) {
      if (kind === "text") mapping.teamName = i;
      continue;
    }
    if (kind === "int") {
      if (mapping.declaredSize === null) mapping.declaredSize = i;
      else if (mapping.declaredRegistered === null) mapping.declaredRegistered = i;
      continue;
    }
    if (kind === "text") {
      if (isContact(i + 1)) {
        // A person: name followed by their contact columns.
        const slot = emptySlot();
        slot.name = i;
        let j = i + 1;
        while (j < kinds.length && isContact(j)) {
          if (kinds[j] === "email" && slot.email === null) slot.email = j;
          else if (kinds[j] === "phone" && slot.phone === null) slot.phone = j;
          j++;
        }
        if (!leaderDone) {
          mapping.leader = slot;
          leaderDone = true;
        } else {
          members.push(slot);
        }
        i = j - 1;
      } else if (mapping.college === null && leaderDone) {
        mapping.college = i;
      }
    }
  }
  mapping.members = members;
  return mapping;
}

/** Best-effort mapping suggestion; the organizer reviews it before importing. */
export function detectMapping(table: PreparedTable): MappingInput {
  return table.headerRow === null ? detectFromContents(table) : detectFromHeaders(table);
}

// ---------------------------------------------------------------------------
// Rows -> candidate teams
// ---------------------------------------------------------------------------

export type IssueSeverity = "error" | "warning" | "info";
export type ImportIssue = {
  severity: IssueSeverity;
  rowNumbers: number[];
  team: string | null;
  message: string;
};

export type CandidateMember = {
  identityKey: string;
  name: string;
  email: string | null;
  phone: string | null;
  externalId: string | null;
  isLeader: boolean;
  position: number;
  rowNumber: number;
};

export type CandidateTeam = {
  key: string;
  teamName: string;
  teamNameKey: string;
  teamCode: string | null;
  college: string | null;
  declaredSize: number | null;
  declaredRegistered: number | null;
  members: CandidateMember[];
  rowNumbers: number[];
  /** Raw cells of the first source row, kept for troubleshooting. */
  sourceCells: string[];
  warnings: string[];
};

export type BuildResult = {
  totalRows: number;
  blankRows: number;
  excludedRows: number;
  skippedRows: number[];
  teams: CandidateTeam[];
  issues: ImportIssue[];
};

type Person = { name: string | null; email: string | null; phone: string | null; externalId: string | null };

function readSlot(cells: string[], slot: Slot): Person | null {
  const get = (i: number | null) => (i === null ? null : cleanText(cells[i]));
  const first = get(slot.name);
  const last = get(slot.lastName);
  const name = [first, last].filter(Boolean).join(" ") || null;
  const rawEmail = normalizeEmail(get(slot.email));
  const phone = normalizePhone(get(slot.phone)) ? get(slot.phone) : null;
  const externalId = get(slot.externalId);
  if (!name && !rawEmail && !phone && !externalId) return null;
  return { name, email: rawEmail, phone, externalId };
}

function parseCount(raw: string | null): { value: number | null; bad: boolean } {
  if (!raw) return { value: null, bad: false };
  if (!/^\d+(\.0+)?$/.test(raw)) return { value: null, bad: true };
  return { value: Number.parseInt(raw, 10), bad: false };
}

type Draft = CandidateTeam & { leaderEmail: string | null; leaderPhone: string | null; leaderName: string | null };

export function buildTeams(table: PreparedTable, mapping: Mapping): BuildResult {
  const result: BuildResult = { totalRows: table.rows.length, blankRows: 0, excludedRows: 0, skippedRows: table.skippedRows, teams: [], issues: [] };
  const issue = (severity: IssueSeverity, rowNumbers: number[], team: string | null, message: string) =>
    result.issues.push({ severity, rowNumbers, team, message });
  const cell = (cells: string[], i: number | null) => (i === null ? null : cleanText(cells[i]));
  const excludeValues = new Set((mapping.exclude?.values ?? []).map((v) => v.trim().toLowerCase()));

  const drafts = new Map<string, Draft>();
  const order: string[] = [];

  for (const { rowNumber, cells } of table.rows) {
    if (cells.every((c) => cleanText(c) === null)) {
      result.blankRows++;
      continue;
    }
    if (mapping.exclude && excludeValues.size > 0 && excludeValues.has((cell(cells, mapping.exclude.column) ?? "").toLowerCase())) {
      result.excludedRows++;
      continue;
    }

    // --- people on this row -------------------------------------------------
    let people: (Person & { isLeader: boolean })[] = [];
    let leaderRef: Person | null;
    if (mapping.layout === "team_row") {
      const leader = readSlot(cells, mapping.leader);
      leaderRef = leader;
      if (leader) people.push({ ...leader, isLeader: true });
      for (const slot of mapping.members) {
        const p = readSlot(cells, slot);
        if (p) people.push({ ...p, isLeader: false });
      }
    } else {
      const p = readSlot(cells, mapping.person);
      leaderRef = readSlot(cells, mapping.leader);
      if (p) {
        const roleCell = (cell(cells, mapping.role) ?? "").toLowerCase();
        const byRole = /^(team ?)?(leader|lead|captain|yes|y|true|1)$/.test(roleCell);
        const byMatch =
          !!leaderRef &&
          ((!!leaderRef.email && leaderRef.email === p.email) || (!leaderRef.email && !!leaderRef.name && !!p.name && normalizeKey(leaderRef.name) === normalizeKey(p.name)));
        people.push({ ...p, isLeader: byRole || byMatch });
      }
    }

    const rawName = cell(cells, mapping.teamName);
    if (people.length === 0) {
      issue("error", [rowNumber], rawName, "Malformed row: no participant names, emails or phone numbers. Row skipped.");
      continue;
    }

    // People listed without a name keep their contact details.
    people = people.map((p) => {
      if (p.name) return p;
      const fallback = p.email?.split("@")[0] ?? p.externalId ?? `Phone ${p.phone}`;
      issue("warning", [rowNumber], rawName, `A participant has no name; imported as "${fallback}" (${p.email ?? p.phone ?? p.externalId}).`);
      return { ...p, name: fallback };
    });

    const leader = people.find((p) => p.isLeader) ?? null;
    let teamName = rawName;
    if (!teamName || isPlaceholderName(teamName)) {
      const who = leader?.name ?? people[0].name!;
      const fallback = `Unnamed team – ${who}`;
      issue("warning", [rowNumber], fallback, `Missing team name${teamName ? ` ("${teamName}")` : ""}; imported as "${fallback}". Rename it in Teams if needed.`);
      teamName = fallback;
    }
    if (teamName.length > 120) {
      issue("error", [rowNumber], teamName.slice(0, 40) + "…", "Team name is longer than 120 characters. Row skipped.");
      continue;
    }
    const teamNameKey = normalizeKey(teamName);
    if (!teamNameKey) {
      issue("error", [rowNumber], teamName, "Team name has no letters or digits. Row skipped.");
      continue;
    }

    const size = parseCount(cell(cells, mapping.declaredSize));
    if (size.bad) issue("warning", [rowNumber], teamName, `Team size "${cell(cells, mapping.declaredSize)}" is not a whole number; ignored.`);
    const registered = parseCount(cell(cells, mapping.declaredRegistered));
    if (registered.bad) issue("warning", [rowNumber], teamName, `Registered count "${cell(cells, mapping.declaredRegistered)}" is not a whole number; ignored.`);

    const teamCode = normalizeTeamCode(cell(cells, mapping.teamCode));
    const leaderForKey = mapping.layout === "team_row" ? leader : leaderRef;
    const key =
      mapping.layout === "participant_row" && !teamCode && !leaderForKey
        ? `team:${teamNameKey}`
        : teamRegistrationKey({
            teamCode,
            teamNameKey,
            leaderEmail: leaderForKey?.email,
            leaderPhone: normalizePhone(leaderForKey?.phone),
            leaderName: leaderForKey?.name,
          });

    let draft = drafts.get(key);
    if (!draft) {
      draft = {
        key,
        teamName,
        teamNameKey,
        teamCode,
        college: cell(cells, mapping.college),
        declaredSize: size.value,
        declaredRegistered: registered.value,
        members: [],
        rowNumbers: [],
        sourceCells: cells,
        warnings: [],
        leaderEmail: leaderForKey?.email ?? null,
        leaderPhone: normalizePhone(leaderForKey?.phone),
        leaderName: leaderForKey?.name ?? null,
      };
      drafts.set(key, draft);
      order.push(key);
    } else if (mapping.layout === "team_row") {
      // The same registration on several rows (e.g. a registration export
      // that repeats the team form for every member).
      const before = new Set(draft.members.map((m) => m.identityKey));
      const incoming = new Set(people.map((p) => participantIdentity({ ...p, name: p.name!, phone: normalizePhone(p.phone) })));
      const same = before.size === incoming.size && [...incoming].every((k) => before.has(k));
      if (same) {
        issue("info", [draft.rowNumbers[0], rowNumber], teamName, `Duplicate registration: row ${rowNumber} repeats row ${draft.rowNumbers[0]}; merged.`);
      } else {
        const msg = `Duplicate registration with different members (rows ${[...draft.rowNumbers, rowNumber].join(", ")}); members combined. Review this team.`;
        issue("warning", [...draft.rowNumbers, rowNumber], teamName, msg);
        draft.warnings.push(msg);
      }
      if (size.value !== null && draft.declaredSize !== null && size.value !== draft.declaredSize) {
        draft.declaredSize = Math.max(draft.declaredSize, size.value);
      }
    }
    draft.rowNumbers.push(rowNumber);
    if (!draft.college) draft.college = cell(cells, mapping.college);

    for (const p of people) {
      const phone = p.phone;
      const identityKey = participantIdentity({ externalId: p.externalId, email: p.email, phone: normalizePhone(phone), name: p.name! });
      const existing = draft.members.find(
        (m) =>
          m.identityKey === identityKey ||
          (!!p.email && m.email === p.email) ||
          (!!normalizePhone(phone) && !!normalizePhone(m.phone) && phoneMatchKey(normalizePhone(m.phone)!) === phoneMatchKey(normalizePhone(phone)!)),
      );
      if (existing) {
        existing.isLeader ||= p.isLeader;
        if (mapping.layout === "team_row" && draft.rowNumbers.length === 1) {
          issue("warning", [rowNumber], teamName, `${p.name} is listed twice in this team; imported once.`);
        }
        continue;
      }
      draft.members.push({
        identityKey,
        name: p.name!,
        email: p.email,
        phone,
        externalId: p.externalId,
        isLeader: p.isLeader,
        position: draft.members.length,
        rowNumber,
      });
      if (p.email && !looksLikeEmail(p.email)) {
        issue("warning", [rowNumber], teamName, `Email "${p.email}" for ${p.name} does not look like an email address.`);
      }
    }
  }

  // --- per-team checks ------------------------------------------------------
  for (const key of order) {
    const d = drafts.get(key)!;
    const leaders = d.members.filter((m) => m.isLeader);
    if (leaders.length === 0) {
      const msg = "No team leader listed.";
      issue("warning", d.rowNumbers, d.teamName, msg);
      d.warnings.push(msg);
    }
    for (const extra of leaders.slice(1)) extra.isLeader = false;

    if (d.members.length > mapping.maxTeamSize) {
      issue("error", d.rowNumbers, d.teamName, `${d.members.length} members exceeds the maximum team size of ${mapping.maxTeamSize}. Team skipped.`);
      drafts.delete(key);
      continue;
    }
    if (d.declaredSize !== null && d.declaredSize !== d.members.length) {
      const msg = `Team size column says ${d.declaredSize} but ${d.members.length} member${d.members.length === 1 ? " is" : "s are"} listed; importing the ${d.members.length} listed.`;
      issue("warning", d.rowNumbers, d.teamName, msg);
      d.warnings.push(msg);
    }
    if (d.declaredRegistered !== null && d.declaredRegistered !== d.members.length) {
      issue("info", d.rowNumbers, d.teamName, `Registered-members column says ${d.declaredRegistered} of ${d.members.length} listed members.`);
    }
  }

  const teams = order.map((k) => drafts.get(k)).filter((d): d is Draft => !!d);

  // --- cross-team checks ----------------------------------------------------
  const byName = new Map<string, Draft[]>();
  for (const t of teams) byName.set(t.teamNameKey, [...(byName.get(t.teamNameKey) ?? []), t]);
  for (const group of byName.values()) {
    if (group.length < 2) continue;
    const desc = group.map((t) => `rows ${t.rowNumbers.join(", ")} (leader ${t.leaderName ?? "unknown"})`).join("; ");
    const msg = `${group.length} different registrations use the team name "${group[0].teamName}": ${desc}. Imported as separate teams with distinct codes; check this is not a duplicate registration.`;
    issue("warning", group.flatMap((t) => t.rowNumbers), group[0].teamName, msg);
    for (const t of group) t.warnings.push("Another registration uses the same team name.");
  }

  const seenPerson = new Map<string, { team: Draft; member: CandidateMember }>();
  for (const t of teams) {
    for (const m of t.members) {
      const keys = [m.email ? `email:${m.email}` : null, normalizePhone(m.phone) ? `phone:${phoneMatchKey(normalizePhone(m.phone)!)}` : null].filter(
        (k): k is string => !!k,
      );
      for (const k of keys) {
        const other = seenPerson.get(k);
        if (other && other.team !== t) {
          const msg = `${m.name} (${k.replace(/^\w+:/, "")}) is registered in both "${other.team.teamName}" (row ${other.member.rowNumber}) and "${t.teamName}" (row ${m.rowNumber}). Duplicate participant: decide which team they belong to.`;
          issue("warning", [other.member.rowNumber, m.rowNumber], t.teamName, msg);
          t.warnings.push(`${m.name} is also registered in ${other.team.teamName}.`);
          other.team.warnings.push(`${m.name} is also registered in ${t.teamName}.`);
          break;
        }
        if (!other) seenPerson.set(k, { team: t, member: m });
      }
    }
  }

  result.teams = teams.map(({ leaderEmail: _e, leaderPhone: _p, leaderName: _n, ...team }) => team);
  return result;
}

/** Codes from the file win; derived codes get a -2, -3… suffix when taken. */
export function assignTeamCodes(teams: { teamName: string; teamCode: string | null }[], taken: Set<string>): string[] {
  const used = new Set(taken);
  const fileCodes = new Set(teams.map((t) => t.teamCode).filter((c): c is string => !!c));
  return teams.map((t) => {
    if (t.teamCode) {
      used.add(t.teamCode);
      return t.teamCode;
    }
    const base = deriveTeamCode(t.teamName);
    let code = base;
    for (let n = 2; used.has(code) || fileCodes.has(code); n++) code = `${base}-${n}`;
    used.add(code);
    return code;
  });
}

import { normalizeKey } from "@/lib/registration-import";

/** One problem-statement form response, as read from the organisers' sheet. */
export type SubmissionEntry = {
  submittedAt: string | null;
  teamName: string;
  leaderName: string | null;
  title: string | null;
  description: string | null;
  repoUrl: string | null;
  psMatch: "yes" | "partial" | "no" | null;
  matchedStatement: string | null;
  notes: string | null;
};

export type Submission = SubmissionEntry & { id: string; teamId: string | null };

export const PS_MATCH_LABELS = { yes: "Matches a problem statement", partial: "Partly matches", no: "Own idea" } as const;

const COLUMNS: Record<keyof SubmissionEntry, string[]> = {
  submittedAt: ["time", "timestamp", "submittedat"],
  teamName: ["teamname", "team"],
  leaderName: ["teamleadername", "leadername", "teamleader", "leader"],
  title: ["problemideatitle", "ideatitle", "title", "problemtitle"],
  description: ["problemideadescription", "ideadescription", "description", "problemdescription"],
  repoUrl: ["githubrepositoryurl", "githubrepository", "githuburl", "repourl", "repository", "github"],
  psMatch: ["inthe20", "matched", "psmatch"],
  matchedStatement: ["matchedproblemstatement", "problemstatement", "statement"],
  notes: ["notes", "remarks", "comments"],
};

const clean = (v: string | undefined) => {
  const t = (v ?? "").replace(/\s+/g, " ").trim();
  return t && t !== "-" ? t : null;
};

/**
 * Only https links are kept, so a pasted `javascript:` or `http:` value can
 * never become a clickable link. A URL pasted twice keeps the first copy.
 */
export function safeRepoUrl(raw: string | null | undefined): string | null {
  const match = (raw ?? "").match(/https:\/\/[^\s,;]+/i);
  if (!match) return null;
  // "…/repo.githttps://…" (pasted twice without a space): cut at the second scheme.
  const first = match[0].split(/(?=https:\/\/)/i)[0];
  try {
    const url = new URL(first);
    if (url.protocol !== "https:" || !url.hostname.includes(".")) return null;
    return url.toString();
  } catch {
    return null;
  }
}

function psMatchOf(raw: string | null): SubmissionEntry["psMatch"] {
  const k = (raw ?? "").toLowerCase();
  return k.startsWith("yes") ? "yes" : k.startsWith("partial") ? "partial" : k.startsWith("no") ? "no" : null;
}

/** Reads the "Submissions" sheet: finds the header row by its column names and maps every response. */
export function parseSubmissionRows(raw: string[][]): SubmissionEntry[] {
  const headerAt = raw.findIndex((r) => {
    const keys = r.map((c) => normalizeKey(c));
    return COLUMNS.teamName.some((a) => keys.includes(a)) && COLUMNS.title.some((a) => keys.includes(a));
  });
  if (headerAt < 0) throw new Error("Couldn't find the header row: the sheet needs at least a team name and an idea title column.");
  const keys = raw[headerAt].map((c) => normalizeKey(c));
  const col = Object.fromEntries(
    (Object.keys(COLUMNS) as (keyof SubmissionEntry)[]).map((f) => [f, keys.findIndex((k) => COLUMNS[f].includes(k))]),
  ) as Record<keyof SubmissionEntry, number>;
  const get = (r: string[], f: keyof SubmissionEntry) => (col[f] >= 0 ? clean(r[col[f]]) : null);

  const out: SubmissionEntry[] = [];
  for (const r of raw.slice(headerAt + 1)) {
    const teamName = get(r, "teamName");
    if (!teamName) continue;
    out.push({
      submittedAt: get(r, "submittedAt"),
      teamName,
      leaderName: get(r, "leaderName"),
      title: get(r, "title"),
      description: get(r, "description"),
      repoUrl: safeRepoUrl(col.repoUrl >= 0 ? r[col.repoUrl] : null),
      psMatch: psMatchOf(get(r, "psMatch")),
      matchedStatement: get(r, "matchedStatement"),
      notes: get(r, "notes"),
    });
  }
  if (out.length === 0) throw new Error("The sheet has a header but no responses.");
  return out;
}

/** A website team as seen by the matcher. */
export type MatchableTeam = { id: string; name: string; leaderName: string | null; members: string[]; active: boolean };

const personKey = (s: string | null | undefined) => normalizeKey(s ?? "");

/**
 * Finds the website team a response belongs to: same team name (ignoring case,
 * spaces and punctuation), preferring the one whose leader matches when a name
 * is shared; otherwise the team whose leader or member has the respondent's
 * name, when exactly one does.
 */
export function matchSubmissionTeam(entry: Pick<SubmissionEntry, "teamName" | "leaderName">, teams: MatchableTeam[]): string | null {
  const key = normalizeKey(entry.teamName);
  const leader = personKey(entry.leaderName);
  const byName = teams.filter((t) => normalizeKey(t.name) === key);
  if (byName.length === 1) return byName[0].id;
  if (byName.length > 1) {
    const sameLeader = byName.filter((t) => leader && t.members.some((m) => personKey(m) === leader));
    return (sameLeader[0] ?? byName.find((t) => t.active) ?? byName[0]).id;
  }
  if (!leader) return null;
  const byPerson = teams.filter((t) => personKey(t.leaderName) === leader || t.members.some((m) => personKey(m) === leader));
  return byPerson.length === 1 ? byPerson[0].id : null;
}

import { normalizeKey } from "@/lib/registration-import";

/** The registration list exported from the MLH portal: name, typed team name, status. */

export const MLH_CHECKED_IN = "checked-in";

export type MlhEntry = { fullName: string; teamName: string; status: string };
export type MlhRow = MlhEntry & { id: string };

const clean = (s: string) => s.replace(/\s+/g, " ").trim();

const HEADER_ALIASES = {
  fullName: ["fullname", "name", "participantname", "attendeename"],
  teamName: ["teamname", "team"],
  status: ["status", "registrationstatus", "checkinstatus"],
} as const;

/** Reads the MLH export (fullname, team_name, status) from raw sheet rows. */
export function parseMlhRows(raw: string[][]): MlhEntry[] {
  const headerAt = raw.findIndex((r) => {
    const keys = r.map((c) => normalizeKey(c));
    return HEADER_ALIASES.fullName.some((a) => keys.includes(a)) && HEADER_ALIASES.status.some((a) => keys.includes(a));
  });
  if (headerAt < 0) throw new Error("Couldn't find the header row. The file needs a name column and a status column (e.g. fullname, team_name, status).");
  const keys = raw[headerAt].map((c) => normalizeKey(c));
  const col = (aliases: readonly string[]) => keys.findIndex((k) => aliases.includes(k));
  const nameCol = col(HEADER_ALIASES.fullName);
  const teamCol = col(HEADER_ALIASES.teamName);
  const statusCol = col(HEADER_ALIASES.status);

  const entries: MlhEntry[] = [];
  for (const r of raw.slice(headerAt + 1)) {
    const fullName = clean(r[nameCol] ?? "");
    if (!fullName) continue;
    entries.push({
      fullName,
      teamName: teamCol >= 0 ? clean(r[teamCol] ?? "") : "",
      status: clean(r[statusCol] ?? "").toLowerCase() || "unknown",
    });
  }
  if (entries.length === 0) throw new Error("The file has a header but no registrations.");
  return entries;
}

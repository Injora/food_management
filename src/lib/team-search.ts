import type { TeamState } from "@/server/services/board";

const squash = (s: string) => s.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}@.]+/gu, "");

/**
 * Relevance of a team for a desk search (0 = no match). Matches team name and
 * code, leader, any member's name, email or phone, ignoring case, spacing and
 * punctuation.
 */
export function teamMatchScore(team: TeamState, query: string): number {
  const q = squash(query);
  if (!q) return 1;
  const name = squash(team.name);
  const code = squash(team.code);
  if (name === q || code === q) return 100;
  if (name.startsWith(q) || code.startsWith(q)) return 80;
  if (name.includes(q)) return 60;
  if (team.leaderName && squash(team.leaderName).includes(q)) return 50;
  const digits = query.replace(/\D/g, "");
  for (const m of team.members) {
    if (squash(m.name).includes(q)) return 40;
    if (m.email?.includes(query.trim().toLowerCase())) return 30;
    if (digits.length >= 4 && m.phone?.replace(/\D/g, "").includes(digits)) return 30;
    if (squash(m.code) === q) return 90;
  }
  return 0;
}

export function searchTeams(teams: TeamState[], query: string): TeamState[] {
  if (!query.trim()) return teams;
  return teams
    .map((t) => ({ t, s: teamMatchScore(t, query) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s || a.t.name.localeCompare(b.t.name))
    .map((x) => x.t);
}

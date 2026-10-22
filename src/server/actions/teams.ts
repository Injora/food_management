"use server";

import { refresh } from "next/cache";

import { runAction } from "@/server/action-result";
import { correctMemberCount, createTeam, deleteTeam, updateTeam } from "@/server/services/teams";

export type TeamFormInput = {
  teamName: string;
  teamCode: string;
  leaderName: string;
  leaderEmail: string;
  memberCount: number;
};

export async function createTeamAction(input: TeamFormInput) {
  const result = await runAction((db, actor) => createTeam(db, actor, input));
  if (result.ok) refresh();
  return result;
}

export async function updateTeamAction(input: TeamFormInput & { teamId: string }) {
  const result = await runAction((db, actor) => updateTeam(db, actor, input));
  if (result.ok) refresh();
  return result;
}

export async function correctMemberCountAction(input: { teamId: string; memberCount: number; reason: string; updatePendingMeals: boolean }) {
  const result = await runAction((db, actor) => correctMemberCount(db, actor, input));
  if (result.ok) refresh();
  return result;
}

export async function deleteTeamAction(input: { teamId: string; reason: string }) {
  return runAction((db, actor) => deleteTeam(db, actor, input));
}

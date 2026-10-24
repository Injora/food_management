"use server";

import { refresh } from "next/cache";

import { runAction } from "@/server/action-result";
import { createRoom, deleteRoom, updateRoom, updateSession } from "@/server/services/rooms";
import {
  addParticipant,
  archiveTeam,
  createTeam,
  deleteTeam,
  getTeamHistory,
  restoreParticipant,
  restoreTeam,
  updateParticipant,
  updateTeam,
  withdrawParticipant,
} from "@/server/services/teams";

type Person = { name: string; email?: string; phone?: string };

export async function teamHistoryAction(teamId: string) {
  return runAction((db, actor) => getTeamHistory(db, actor, teamId));
}

export async function createTeamAction(input: { teamName: string; college?: string; members: Person[]; leaderIndex: number }) {
  return runAction((db, actor) => createTeam(db, actor, input));
}

export async function updateTeamAction(input: { teamId: string; teamName: string; college?: string }) {
  return runAction((db, actor) => updateTeam(db, actor, input));
}

export async function archiveTeamAction(input: { teamId: string; reason: string }) {
  const result = await runAction((db, actor) => archiveTeam(db, actor, input));
  if (result.ok) refresh();
  return result;
}

export async function restoreTeamAction(input: { teamId: string }) {
  const result = await runAction((db, actor) => restoreTeam(db, actor, input));
  if (result.ok) refresh();
  return result;
}

export async function deleteTeamAction(input: { teamId: string; reason: string }) {
  const result = await runAction((db, actor) => deleteTeam(db, actor, input));
  if (result.ok) refresh();
  return result;
}

export async function addParticipantAction(input: Person & { teamId: string; isLeader?: boolean }) {
  return runAction((db, actor) => addParticipant(db, actor, input));
}

export async function updateParticipantAction(input: Person & { participantId: string; isLeader: boolean }) {
  return runAction((db, actor) => updateParticipant(db, actor, input));
}

export async function withdrawParticipantAction(input: { participantId: string; reason: string }) {
  return runAction((db, actor) => withdrawParticipant(db, actor, input));
}

export async function restoreParticipantAction(input: { participantId: string }) {
  return runAction((db, actor) => restoreParticipant(db, actor, input));
}

export async function updateRoomAction(input: { roomId: string; nominalCapacity: number | null; overflowTolerance: number }) {
  const result = await runAction((db, actor) => updateRoom(db, actor, input));
  if (result.ok) refresh();
  return result;
}

export async function createRoomAction(input: { sessionId: string; roomNumber: string; nominalCapacity: number | null; overflowTolerance: number }) {
  const result = await runAction((db, actor) => createRoom(db, actor, input));
  if (result.ok) refresh();
  return result;
}

export async function deleteRoomAction(input: { roomId: string }) {
  const result = await runAction((db, actor) => deleteRoom(db, actor, input));
  if (result.ok) refresh();
  return result;
}

export async function updateSessionAction(input: { sessionId: string; name: string; startsAt: string; endsAt: string; overflowTolerance: number }) {
  const result = await runAction((db, actor) => updateSession(db, actor, input));
  if (result.ok) refresh();
  return result;
}

"use server";

import { runAction } from "@/server/action-result";
import { checkIn, undoCheckIn } from "@/server/services/checkin";
import { issueCoupons, revertCoupon } from "@/server/services/coupons";
import { allocateTeam, moveTeam, releaseAllocation } from "@/server/services/rooms";

// Desk operations. The calling screen refetches the live board afterwards,
// so these return only what the toast needs.

export async function checkInAction(input: { teamId: string; participantIds?: string[]; wholeTeam?: boolean }) {
  return runAction((db, actor) => checkIn(db, actor, input));
}

export async function undoCheckInAction(input: { teamId: string; participantIds: string[]; reason?: string }) {
  return runAction((db, actor) => undoCheckIn(db, actor, input));
}

export async function issueCouponsAction(input: {
  teamId: string;
  couponType: string;
  participantIds?: string[];
  allPending?: boolean;
  requestId: string;
}) {
  return runAction((db, actor) => issueCoupons(db, actor, input));
}

export async function revertCouponAction(input: { issuanceId: string; reason: string }) {
  return runAction((db, actor) => revertCoupon(db, actor, input));
}

export async function allocateTeamAction(input: { sessionId: string; teamId: string; roomId: string; participantIds: string[] }) {
  return runAction((db, actor) => allocateTeam(db, actor, input));
}

export async function moveTeamAction(input: { sessionId: string; teamId: string; toRoomId: string; participantIds?: string[] }) {
  return runAction((db, actor) => moveTeam(db, actor, input));
}

export async function releaseAllocationAction(input: { sessionId: string; teamId: string; participantIds?: string[]; reason?: string }) {
  return runAction((db, actor) => releaseAllocation(db, actor, input));
}

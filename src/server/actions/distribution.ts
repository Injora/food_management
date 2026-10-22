"use server";

import { refresh } from "next/cache";

import { runAction } from "@/server/action-result";
import {
  correctCouponQuantity,
  issueCoupons,
  revertIssuance,
  type IssueInput,
} from "@/server/services/distribution";

/** Called from the meal board, which updates its own state from the result. */
export async function issueCouponsAction(input: IssueInput) {
  return runAction((db, actor) => issueCoupons(db, actor, input));
}

export async function revertIssuanceAction(input: { teamId: string; meal: string; reason: string }) {
  const result = await runAction((db, actor) => revertIssuance(db, actor, input));
  if (result.ok) refresh();
  return result;
}

export async function correctCouponQuantityAction(input: { teamId: string; meal: string; quantity: number; reason: string }) {
  const result = await runAction((db, actor) => correctCouponQuantity(db, actor, input));
  if (result.ok) refresh();
  return result;
}

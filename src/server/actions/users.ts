"use server";

import { refresh } from "next/cache";

import { runAction } from "@/server/action-result";
import { createUser, updateUser } from "@/server/services/users";

export async function createUserAction(input: { email: string; name: string; role: string; password: string }) {
  const result = await runAction((db, actor) => createUser(db, actor, input));
  if (result.ok) refresh();
  return result;
}

export async function updateUserAction(input: { userId: string; name?: string; role?: string; active?: boolean; password?: string }) {
  const result = await runAction((db, actor) => updateUser(db, actor, input));
  if (result.ok) refresh();
  return result;
}

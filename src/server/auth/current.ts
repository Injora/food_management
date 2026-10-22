import "server-only";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";

import { getDb } from "@/db";
import type { Actor } from "./permissions";
import { validateSessionToken } from "./session";

export const SESSION_COOKIE = "fm_session";

/** The signed-in user for this request, or null. Deduplicated per request. */
export const getActor = cache(async (): Promise<Actor | null> => {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return null;
  return validateSessionToken(getDb(), token);
});

/** For pages: sends anonymous visitors to the login screen. */
export async function requireActor(): Promise<Actor> {
  const actor = await getActor();
  if (!actor) redirect("/login");
  return actor;
}

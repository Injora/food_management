"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";

import { getDb } from "@/db";
import { SESSION_COOKIE } from "@/server/auth/current";
import { authenticate, createSession, deleteSession } from "@/server/auth/session";
import { toActionError } from "@/server/action-result";

export type LoginState = { error: string | null; email: string };

const loginSchema = z.object({
  email: z.string().trim().min(1).max(254),
  password: z.string().min(1).max(200),
  next: z.string().max(500).optional(),
});

/** Only same-site relative paths, so `?next=` can't become an open redirect. */
function safeNext(next: string | undefined) {
  return next && next.startsWith("/") && !next.startsWith("//") && !next.startsWith("/login") ? next : "/";
}

export async function login(_prev: LoginState, formData: FormData): Promise<LoginState> {
  const parsed = loginSchema.safeParse(Object.fromEntries(formData));
  const email = String(formData.get("email") ?? "");
  if (!parsed.success) return { error: "Enter your email and password.", email };

  let destination: string;
  try {
    const db = getDb();
    const actor = await authenticate(db, parsed.data.email, parsed.data.password);
    if (!actor) return { error: "Incorrect email or password, or the account is disabled.", email };
    const { token, expiresAt } = await createSession(db, actor.id);
    (await cookies()).set(SESSION_COOKIE, token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
      expires: expiresAt,
    });
    destination = safeNext(parsed.data.next);
  } catch (err) {
    return { error: toActionError(err).error.message, email };
  }
  redirect(destination);
}

export async function logout() {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (token) {
    try {
      await deleteSession(getDb(), token);
    } catch (err) {
      // The cookie is still cleared below; the orphaned row expires on its own.
      console.error("[auth] failed to delete session", err);
    }
  }
  store.delete(SESSION_COOKIE);
  redirect("/login");
}

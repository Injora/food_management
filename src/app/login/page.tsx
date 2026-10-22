import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { Ticket } from "lucide-react";

import { getActor } from "@/server/auth/current";
import { LoginForm } from "./login-form";

export const metadata: Metadata = { title: "Sign in" };

export default async function LoginPage({ searchParams }: PageProps<"/login">) {
  const { next } = await searchParams;
  let signedIn = false;
  try {
    signedIn = !!(await getActor());
  } catch {
    // Database unreachable: still show the form; signing in reports the error.
  }
  if (signedIn) redirect("/");

  return (
    <div className="flex min-h-dvh items-center justify-center px-4 py-12">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex flex-col items-center text-center">
          <span className="flex size-11 items-center justify-center rounded-xl bg-primary text-primary-foreground">
            <Ticket className="size-5.5" aria-hidden />
          </span>
          <h1 className="mt-4 text-xl font-semibold tracking-tight">Food Desk</h1>
          <p className="mt-1 text-sm text-muted-foreground">Sign in with your organizer account</p>
        </div>
        <LoginForm next={typeof next === "string" ? next : undefined} />
      </div>
    </div>
  );
}

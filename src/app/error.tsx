"use client";

import { RefreshCw, TriangleAlert } from "lucide-react";

import { Button } from "@/components/ui/button";

export default function RootError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  // Server errors arrive with a generic message in production; the digest
  // matches the server log entry.
  const dbIssue = /DATABASE_URL|database|connect|ECONNREFUSED/i.test(error.message);
  return (
    <div className="flex min-h-dvh items-center justify-center px-4">
      <div className="max-w-md rounded-xl border bg-card p-8 text-center">
        <TriangleAlert className="mx-auto size-8 text-destructive" aria-hidden />
        <h1 className="mt-3 text-lg font-semibold">{dbIssue ? "Can't reach the database" : "Something went wrong"}</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {dbIssue
            ? "The app couldn't connect to PostgreSQL. Check the network or the DATABASE_URL setting, then retry."
            : "The page failed to load. Nothing was changed. Try again, and tell an admin if it keeps happening."}
        </p>
        {error.digest && <p className="mt-3 font-mono text-xs text-muted-foreground">Reference: {error.digest}</p>}
        <Button className="mt-5" onClick={reset}>
          <RefreshCw /> Retry
        </Button>
      </div>
    </div>
  );
}

"use client";

import { useRouter } from "next/navigation";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

import { callAction } from "@/lib/client-fetch";
import type { ActionError, ActionResult } from "@/lib/errors";
import type { Role } from "@/lib/domain";
import { can, type Permission } from "@/server/auth/permissions";
import type { Board } from "@/server/services/board";

/**
 * Live operational state shared by every page. It is polled from the
 * database every few seconds while the tab is visible, and refetched right
 * after every change this volunteer makes. Polling (rather than push) keeps
 * the server stateless on serverless hosting; the database is authoritative,
 * so a slightly stale screen can never over-issue or overfill a room — the
 * server rejects the write and the screen updates.
 */

const POLL_MS = 4000;

type Sync = { at: Date | null; offline: boolean };
type Viewer = { name: string; role: Role };

type BoardContextValue = {
  board: Board;
  sync: Sync;
  viewer: Viewer;
  refresh: () => Promise<void>;
  allowed: (permission: Permission) => boolean;
};

const BoardContext = createContext<BoardContextValue | null>(null);

export function BoardProvider({ initial, viewer, children }: { initial: Board; viewer: Viewer; children: React.ReactNode }) {
  const [board, setBoard] = useState(initial);
  const [sync, setSync] = useState<Sync>({ at: null, offline: false });
  const router = useRouter();
  const inFlight = useRef<Promise<void> | null>(null);

  const refresh = useCallback(() => {
    // Coalesce overlapping refreshes (poll + post-action).
    inFlight.current ??= (async () => {
      try {
        const res = await fetch("/api/board", { cache: "no-store" });
        if (res.status === 401) {
          router.push(`/login?next=${encodeURIComponent(location.pathname + location.search)}`);
          return;
        }
        const body = (await res.json()) as ActionResult<Board>;
        if (!body.ok) throw new Error(body.error.message);
        setBoard(body.data);
        setSync({ at: new Date(), offline: false });
      } catch {
        setSync((s) => ({ ...s, offline: true }));
      } finally {
        inFlight.current = null;
      }
    })();
    return inFlight.current;
  }, [router]);

  useEffect(() => {
    const id = setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, POLL_MS);
    const onVisible = () => document.visibilityState === "visible" && void refresh();
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("online", onVisible);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("online", onVisible);
    };
  }, [refresh]);

  const value = useMemo<BoardContextValue>(
    () => ({ board, sync, viewer, refresh, allowed: (p) => can({ id: "", email: "", ...viewer }, p) }),
    [board, sync, viewer, refresh],
  );
  return <BoardContext.Provider value={value}>{children}</BoardContext.Provider>;
}

export function useBoard() {
  const ctx = useContext(BoardContext);
  if (!ctx) throw new Error("useBoard must be used inside BoardProvider");
  return ctx;
}

type RunOptions<T> = {
  success?: (data: T) => string | null;
  /** Return true when the error was shown in place, to skip the toast. */
  onError?: (error: ActionError) => boolean | void;
};

/**
 * Runs a server action with one-at-a-time protection (a second click while a
 * request is in flight is ignored), toasts the outcome and refetches the
 * board. The UI only changes once the server has committed, so there is no
 * optimistic state to roll back.
 */
export function useRun() {
  const { refresh } = useBoard();
  const [pending, setPending] = useState<string | null>(null);
  const busy = useRef(false);

  const run = useCallback(
    async <T,>(key: string, fn: () => Promise<ActionResult<T>>, opts: RunOptions<T> = {}): Promise<ActionResult<T> | null> => {
      if (busy.current) return null;
      busy.current = true;
      setPending(key);
      try {
        const res = await callAction(fn);
        if (res.ok) {
          const msg = opts.success?.(res.data);
          if (msg) toast.success(msg);
        } else if (!opts.onError?.(res.error)) {
          toast.error(res.error.message);
        }
        await refresh();
        return res;
      } finally {
        busy.current = false;
        setPending(null);
      }
    },
    [refresh],
  );
  return { run, pending };
}

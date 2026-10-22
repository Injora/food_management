"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  CircleCheckBig,
  History,
  LoaderCircle,
  RefreshCw,
  Search,
  Ticket,
  TriangleAlert,
  Users,
  WifiOff,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { cn } from "cn";

import { EmptyState } from "@/components/empty-state";
import { MEAL_ICONS } from "@/components/meal-icon";
import { NativeSelect } from "@/components/native-select";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { callAction } from "@/lib/client-fetch";
import type { ActionError, ActionResult } from "@/lib/errors";
import { formatNumber, formatTime } from "@/lib/format";
import { MEAL_LABELS, MEAL_TYPES, type MealType } from "@/lib/meals";
import { issueCouponsAction } from "@/server/actions/distribution";
import type { MealRow } from "@/server/services/distribution";

const PAGE_SIZE = 50;
const POLL_MS = 8000;

type Filter = "all" | "pending" | "issued";
type Sort = "name" | "size_desc" | "size_asc" | "status";

const squash = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");

/** Higher is a better match; 0 means no match. */
function matchScore(row: MealRow, q: string, qSquashed: string): number {
  const code = squash(row.teamCode);
  const name = squash(row.teamName);
  if (qSquashed && code === qSquashed) return 100;
  if (qSquashed && name === qSquashed) return 90;
  if (qSquashed && code.startsWith(qSquashed)) return 70;
  if (qSquashed && name.startsWith(qSquashed)) return 60;
  if (qSquashed && (name.includes(qSquashed) || code.includes(qSquashed))) return 40;
  const ql = q.toLowerCase();
  if (row.leaderName?.toLowerCase().includes(ql)) return 30;
  if (row.leaderEmail?.includes(ql)) return 20;
  return 0;
}

export function MealBoard({ meal, initialRows }: { meal: MealType; initialRows: MealRow[] }) {
  const [rows, setRows] = useState(initialRows);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [sort, setSort] = useState<Sort>("name");
  const [page, setPage] = useState(0);
  const [selected, setSelected] = useState(0);
  const [target, setTarget] = useState<MealRow | null>(null);
  const [sync, setSync] = useState<{ at: Date | null; offline: boolean }>({ at: null, offline: false });
  const searchRef = useRef<HTMLInputElement>(null);
  const router = useRouter();
  const MealIcon = MEAL_ICONS[meal];

  // --- Live sync with other organizers -----------------------------------
  const refreshRows = useCallback(async () => {
    try {
      const res = await fetch(`/api/meals/${meal}`, { cache: "no-store" });
      if (res.status === 401) {
        router.push(`/login?next=/meals/${meal}`);
        return;
      }
      const body = (await res.json()) as ActionResult<MealRow[]>;
      if (!body.ok) throw new Error(body.error.message);
      setRows(body.data);
      setSync({ at: new Date(), offline: false });
    } catch {
      setSync((s) => ({ ...s, offline: true }));
    }
  }, [meal, router]);

  useEffect(() => {
    const id = setInterval(() => {
      if (document.visibilityState === "visible") void refreshRows();
    }, POLL_MS);
    const onVisible = () => document.visibilityState === "visible" && void refreshRows();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [refreshRows]);

  // --- "/" focuses search from anywhere ----------------------------------
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (e.key === "/" && !target && !["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName)) {
        e.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [target]);

  // --- Derived lists -------------------------------------------------------
  const counts = useMemo(() => {
    let issuedTeams = 0;
    let couponsIssued = 0;
    let couponsExpected = 0;
    for (const r of rows) {
      couponsExpected += r.couponQuantity;
      if (r.status === "issued") {
        issuedTeams++;
        couponsIssued += r.couponQuantity;
      }
    }
    return { total: rows.length, issuedTeams, pendingTeams: rows.length - issuedTeams, couponsIssued, couponsRemaining: couponsExpected - couponsIssued };
  }, [rows]);

  const visible = useMemo(() => {
    const q = query.trim();
    const qs = squash(q);
    let list = rows.map((row) => ({ row, score: q ? matchScore(row, q, qs) : 1 })).filter((x) => x.score > 0);
    if (filter !== "all") list = list.filter((x) => x.row.status === filter);
    const bySort = (a: MealRow, b: MealRow) => {
      if (sort === "size_desc") return b.memberCount - a.memberCount || a.teamName.localeCompare(b.teamName);
      if (sort === "size_asc") return a.memberCount - b.memberCount || a.teamName.localeCompare(b.teamName);
      if (sort === "status") return (a.status === "pending" ? 0 : 1) - (b.status === "pending" ? 0 : 1) || a.teamName.localeCompare(b.teamName);
      return a.teamName.localeCompare(b.teamName);
    };
    list.sort((a, b) => b.score - a.score || bySort(a.row, b.row));
    return list.map((x) => x.row);
  }, [rows, query, filter, sort]);

  const pageCount = Math.max(1, Math.ceil(visible.length / PAGE_SIZE));
  const currentPage = Math.min(page, pageCount - 1);
  const pageRows = visible.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE);
  const selectedIndex = Math.min(selected, Math.max(0, pageRows.length - 1));

  const resetPaging = () => {
    setPage(0);
    setSelected(0);
  };

  const openIssue = (row: MealRow) => {
    if (row.status === "issued") return;
    setTarget(row);
  };

  const onSearchKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelected((i) => Math.min(i + 1, pageRows.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelected((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const row = pageRows[selectedIndex];
      if (row) openIssue(row);
    } else if (e.key === "Escape" && query) {
      e.preventDefault();
      setQuery("");
      resetPaging();
    }
  };

  const applyIssued = (teamId: string, patch: Partial<MealRow>) =>
    setRows((rs) => rs.map((r) => (r.teamId === teamId ? { ...r, ...patch } : r)));

  return (
    <div className="flex flex-col gap-4">
      {/* Header */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-3">
          <span className="flex size-10 items-center justify-center rounded-xl bg-accent text-accent-foreground">
            <MealIcon className="size-5" aria-hidden />
          </span>
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">{MEAL_LABELS[meal]}</h1>
            <SyncIndicator sync={sync} onRefresh={refreshRows} />
          </div>
        </div>
        <nav aria-label="Switch meal" className="flex rounded-lg border bg-card p-1">
          {MEAL_TYPES.map((m) => {
            const Icon = MEAL_ICONS[m];
            return (
              <Link
                key={m}
                href={`/meals/${m}`}
                aria-current={m === meal ? "page" : undefined}
                className={cn(
                  "flex h-9 flex-1 items-center justify-center gap-1.5 rounded-md px-3 text-sm font-medium outline-none focus-visible:ring-3 focus-visible:ring-ring/50 sm:flex-none",
                  m === meal ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted hover:text-foreground",
                )}
              >
                <Icon className="size-4" aria-hidden />
                {MEAL_LABELS[m]}
              </Link>
            );
          })}
        </nav>
      </div>

      {/* Live counters: teams vs coupons kept visually distinct */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Counter label="Teams pending" value={counts.pendingTeams} tone="warning" />
        <Counter label="Teams collected" value={counts.issuedTeams} sub={`of ${formatNumber(counts.total)}`} tone="success" />
        <Counter label="Coupons remaining" value={counts.couponsRemaining} icon />
        <Counter label="Coupons issued" value={counts.couponsIssued} icon />
      </div>

      {/* Search + filters */}
      <div className="sticky top-14 z-20 -mx-4 flex flex-col gap-2 border-b bg-background/95 px-4 py-3 backdrop-blur sm:mx-0 sm:rounded-xl sm:border sm:bg-card sm:px-3 lg:top-2">
        <div className="relative">
          <Search className="pointer-events-none absolute top-1/2 left-3.5 size-5 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <Input
            ref={searchRef}
            type="search"
            inputMode="search"
            autoFocus
            autoComplete="off"
            spellCheck={false}
            aria-label="Search teams"
            placeholder="Team name, code, leader or email"
            className="h-12 pr-20 pl-11 text-base md:text-base"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              resetPaging();
            }}
            onKeyDown={onSearchKey}
          />
          {query ? (
            <Button
              variant="ghost"
              size="icon-sm"
              className="absolute top-1/2 right-2 -translate-y-1/2"
              aria-label="Clear search"
              onClick={() => {
                setQuery("");
                resetPaging();
                searchRef.current?.focus();
              }}
            >
              <X />
            </Button>
          ) : (
            <kbd className="pointer-events-none absolute top-1/2 right-3 hidden -translate-y-1/2 rounded border bg-muted px-1.5 font-mono text-xs text-muted-foreground sm:block">
              /
            </kbd>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div role="radiogroup" aria-label="Filter by status" className="flex rounded-lg bg-muted p-0.5">
            {(
              [
                ["all", `All ${counts.total}`],
                ["pending", `Pending ${counts.pendingTeams}`],
                ["issued", `Issued ${counts.issuedTeams}`],
              ] as const
            ).map(([value, label]) => (
              <button
                key={value}
                type="button"
                role="radio"
                aria-checked={filter === value}
                onClick={() => {
                  setFilter(value);
                  resetPaging();
                }}
                className={cn(
                  "tabular h-8 rounded-md px-3 text-sm font-medium outline-none focus-visible:ring-3 focus-visible:ring-ring/50",
                  filter === value ? "bg-background text-foreground shadow-xs" : "text-muted-foreground hover:text-foreground",
                )}
              >
                {label}
              </button>
            ))}
          </div>
          <NativeSelect
            aria-label="Sort"
            className="w-44"
            value={sort}
            onChange={(e) => {
              setSort(e.target.value as Sort);
              resetPaging();
            }}
          >
            <option value="name">Sort: Team name</option>
            <option value="status">Sort: Pending first</option>
            <option value="size_desc">Sort: Largest teams</option>
            <option value="size_asc">Sort: Smallest teams</option>
          </NativeSelect>
          <p className="ml-auto hidden text-xs text-muted-foreground md:block">
            <kbd className="font-mono">↑</kbd> <kbd className="font-mono">↓</kbd> select · <kbd className="font-mono">Enter</kbd> issue ·{" "}
            <kbd className="font-mono">Esc</kbd> clear
          </p>
        </div>
      </div>

      {/* Results */}
      {rows.length === 0 ? (
        <EmptyState icon={Users} title="No teams imported yet">
          An admin needs to import the team list before coupons can be issued.
        </EmptyState>
      ) : visible.length === 0 ? (
        <EmptyState icon={Search} title="No matching teams">
          {query ? (
            <>
              Nothing matches &ldquo;{query}&rdquo;
              {filter !== "all" && " with this filter"}. Check the spelling, try the team code or the leader&apos;s name.
            </>
          ) : (
            "No teams with this status."
          )}
        </EmptyState>
      ) : (
        <div className="overflow-hidden rounded-xl border bg-card">
          <div
            role="row"
            className="hidden grid-cols-[minmax(0,1fr)_6rem_7rem_11rem_10rem] gap-4 border-b bg-muted/50 px-4 py-2 text-xs font-medium tracking-wide text-muted-foreground uppercase md:grid"
          >
            <span>Team</span>
            <span className="text-right">Members</span>
            <span className="text-right">Coupons</span>
            <span>Status</span>
            <span className="sr-only">Actions</span>
          </div>
          <ul aria-label={`${MEAL_LABELS[meal]} teams`} className="divide-y">
            {pageRows.map((row, i) => (
              <TeamRow key={row.teamId} row={row} meal={meal} active={i === selectedIndex && query !== ""} onIssue={() => openIssue(row)} />
            ))}
          </ul>
          {pageCount > 1 && (
            <div className="flex items-center justify-between gap-2 border-t px-4 py-2 text-sm">
              <span className="tabular text-muted-foreground">
                {currentPage * PAGE_SIZE + 1}–{Math.min((currentPage + 1) * PAGE_SIZE, visible.length)} of {visible.length}
              </span>
              <div className="flex gap-1">
                <Button variant="outline" size="icon" aria-label="Previous page" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>
                  <ChevronLeft />
                </Button>
                <Button
                  variant="outline"
                  size="icon"
                  aria-label="Next page"
                  disabled={currentPage >= pageCount - 1}
                  onClick={() => setPage(currentPage + 1)}
                >
                  <ChevronRight />
                </Button>
              </div>
            </div>
          )}
        </div>
      )}

      <IssueDialog
        meal={meal}
        target={target}
        onClose={() => setTarget(null)}
        returnFocus={searchRef}
        onIssued={(row, issuedAt, issuedByName, couponQuantity) => {
          applyIssued(row.teamId, { status: "issued", issuedAt, issuedByName, couponQuantity });
          setQuery("");
          resetPaging();
        }}
        onStale={(row, patch) => applyIssued(row.teamId, patch)}
      />
    </div>
  );
}

function SyncIndicator({ sync, onRefresh }: { sync: { at: Date | null; offline: boolean }; onRefresh: () => void }) {
  return (
    <p className="flex items-center gap-1.5 text-xs text-muted-foreground" aria-live="polite">
      {sync.offline ? (
        <>
          <WifiOff className="size-3.5 text-destructive" aria-hidden />
          <span className="text-destructive">Offline: showing last known status</span>
        </>
      ) : (
        <>
          <span className="size-2 rounded-full bg-success" aria-hidden />
          Live{sync.at ? ` · synced ${formatTime(sync.at.toISOString())}` : ""}
        </>
      )}
      <button type="button" onClick={onRefresh} className="ml-1 rounded p-0.5 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none" aria-label="Refresh now">
        <RefreshCw className="size-3.5" />
      </button>
    </p>
  );
}

function Counter({ label, value, sub, tone, icon }: { label: string; value: number; sub?: string; tone?: "success" | "warning"; icon?: boolean }) {
  return (
    <div className="rounded-xl border bg-card px-3 py-2.5">
      <p className="flex items-center gap-1 text-[11px] font-semibold tracking-wider text-muted-foreground uppercase">
        {icon ? <Ticket className="size-3.5" aria-hidden /> : <Users className="size-3.5" aria-hidden />}
        {label}
      </p>
      <p
        className={cn(
          "tabular mt-0.5 text-xl font-semibold",
          tone === "success" && "text-success-foreground",
          tone === "warning" && "text-warning-foreground",
        )}
      >
        {formatNumber(value)} {sub && <span className="text-sm font-normal text-muted-foreground">{sub}</span>}
      </p>
    </div>
  );
}

function TeamRow({ row, meal, active, onIssue }: { row: MealRow; meal: MealType; active: boolean; onIssue: () => void }) {
  const issued = row.status === "issued";
  return (
    <li
      aria-current={active ? "true" : undefined}
      className={cn(
        "grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-2 border-l-4 px-4 py-3 md:grid-cols-[minmax(0,1fr)_6rem_7rem_11rem_10rem]",
        issued ? "border-l-success bg-success-soft/40" : "border-l-transparent",
        active && "bg-accent/70 ring-2 ring-ring/40 ring-inset",
      )}
    >
      <div className="min-w-0">
        <p className="truncate text-base font-semibold">
          {row.teamName} <span className="ml-1 font-mono text-xs font-normal text-muted-foreground">{row.teamCode}</span>
        </p>
        <p className="truncate text-sm text-muted-foreground">
          {row.leaderName ?? "No leader listed"}
          {row.leaderEmail && <span className="hidden sm:inline"> · {row.leaderEmail}</span>}
        </p>
      </div>

      {/* Mobile: compact numbers beside the name */}
      <div className="flex flex-col items-end md:hidden">
        <span className="tabular text-2xl leading-none font-semibold">{row.couponQuantity}</span>
        <span className="text-xs text-muted-foreground">coupons · {row.memberCount} members</span>
      </div>

      <p className="tabular hidden text-right text-base md:block">{row.memberCount}</p>
      <p className="tabular hidden text-right text-xl font-semibold md:block">{row.couponQuantity}</p>

      <div className="col-span-2 flex items-center gap-2 md:col-span-1 md:flex-col md:items-start md:gap-0.5">
        <StatusBadge status={row.status} />
        {issued && (
          <span className="text-xs text-muted-foreground">
            {formatTime(row.issuedAt)}
            {row.issuedByName && ` · ${row.issuedByName}`}
          </span>
        )}
      </div>

      <div className="col-span-2 flex items-center gap-2 md:col-span-1 md:justify-end">
        {!issued && (
          <Button size="lg" className="h-11 flex-1 text-base md:h-10 md:flex-none md:text-sm" onClick={onIssue}>
            <Ticket /> Issue {row.couponQuantity}
          </Button>
        )}
        <Button
          variant="ghost"
          size="icon-lg"
          aria-label={`History for ${row.teamName}`}
          title="Team history"
          nativeButton={false}
          render={<Link href={`/teams/${row.teamId}?from=${meal}`} />}
          className={cn(issued && "ml-auto md:ml-0")}
        >
          <History />
        </Button>
      </div>
    </li>
  );
}

type DialogError = ActionError & { uncertain?: boolean };

function IssueDialog({
  meal,
  target,
  onClose,
  onIssued,
  onStale,
  returnFocus,
}: {
  meal: MealType;
  target: MealRow | null;
  onClose: () => void;
  onIssued: (row: MealRow, issuedAt: string, issuedByName: string, couponQuantity: number) => void;
  onStale: (row: MealRow, patch: Partial<MealRow>) => void;
  returnFocus: React.RefObject<HTMLInputElement | null>;
}) {
  const [row, setRow] = useState<MealRow | null>(target);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<DialogError | null>(null);
  // One id per confirmation: retries after a network failure reuse it, so the
  // server recognises them and can never issue twice.
  const router = useRouter();
  const [requestId, setRequestId] = useState("");
  const confirmRef = useRef<HTMLButtonElement>(null);
  // Guards against double-submission between click and the pending re-render.
  const inFlight = useRef(false);

  const [lastTarget, setLastTarget] = useState(target);
  if (target !== lastTarget) {
    setLastTarget(target);
    if (target) {
      setRow(target);
      setError(null);
      setRequestId(crypto.randomUUID());
    }
  }

  const submit = async () => {
    if (!row || !requestId || inFlight.current) return;
    inFlight.current = true;
    setPending(true);
    setError(null);
    const result = await callAction(() =>
      issueCouponsAction({ teamId: row.teamId, meal, expectedQuantity: row.couponQuantity, requestId }),
    );
    inFlight.current = false;
    setPending(false);

    if (result.ok) {
      const d = result.data;
      onIssued(row, d.issuedAt, d.issuedByName, d.couponQuantity);
      toast.success(`${d.couponQuantity} ${MEAL_LABELS[meal].toLowerCase()} coupons issued to ${d.teamName}`, {
        description: d.replayed ? "Confirmed after reconnecting; it was recorded only once." : `Recorded at ${formatTime(d.issuedAt)}`,
      });
      onClose();
      return;
    }

    const err = result.error;
    if (err.code === "ALREADY_ISSUED") {
      const details = err.details as { issuedAt: string; issuedByName: string | null; couponQuantity: number };
      onStale(row, { status: "issued", issuedAt: details.issuedAt, issuedByName: details.issuedByName, couponQuantity: details.couponQuantity });
      toast.error("Already issued", { description: `${err.message} (${formatTime(details.issuedAt)})`, duration: 8000 });
      onClose();
      return;
    }
    if (err.code === "QUANTITY_CHANGED") {
      const quantity = (err.details as { couponQuantity: number }).couponQuantity;
      const updated = { ...row, couponQuantity: quantity };
      setRow(updated);
      onStale(row, { couponQuantity: quantity });
    }
    if (err.code === "UNAUTHORIZED") {
      router.push(`/login?next=/meals/${meal}`);
      return;
    }
    setError({ ...err, uncertain: err.code === "NETWORK" });
    confirmRef.current?.focus();
  };

  const differs = row && row.couponQuantity !== row.memberCount;

  return (
    <Dialog open={!!target} onOpenChange={(open) => !open && !pending && onClose()}>
      <DialogContent initialFocus={confirmRef} finalFocus={returnFocus} className="sm:max-w-md" showCloseButton={!pending}>
        {row && (
          <form
            className="contents"
            onSubmit={(e) => {
              e.preventDefault();
              void submit();
            }}
          >
            <DialogHeader>
              <DialogTitle>Issue {MEAL_LABELS[meal].toLowerCase()} coupons?</DialogTitle>
              <DialogDescription>Hand over the coupons after confirming. This is recorded with your name and the time.</DialogDescription>
            </DialogHeader>

            <div className="rounded-xl border bg-muted/40 p-4">
              <p className="text-lg leading-tight font-semibold">{row.teamName}</p>
              <p className="mt-0.5 text-sm text-muted-foreground">
                <span className="font-mono">{row.teamCode}</span>
                {row.leaderName && ` · Leader: ${row.leaderName}`}
              </p>
              <div className="mt-4 flex items-end justify-between gap-4">
                <div>
                  <p className="text-xs font-semibold tracking-wider text-muted-foreground uppercase">{MEAL_LABELS[meal]} coupons</p>
                  <p className="tabular text-5xl leading-none font-bold tracking-tight">{row.couponQuantity}</p>
                </div>
                <p className="tabular text-right text-sm text-muted-foreground">
                  {row.memberCount} registered member{row.memberCount === 1 ? "" : "s"}
                </p>
              </div>
              {differs && (
                <p className="mt-3 flex items-start gap-1.5 text-xs text-warning-foreground">
                  <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                  An admin set this meal&apos;s quantity to differ from the member count.
                </p>
              )}
            </div>

            {error && (
              <div
                role="alert"
                className={cn(
                  "flex items-start gap-2 rounded-lg px-3 py-2 text-sm",
                  error.uncertain ? "bg-warning-soft text-warning-foreground" : "bg-destructive/10 text-destructive",
                )}
              >
                <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
                <span>
                  {error.uncertain
                    ? "Connection lost: we couldn't confirm whether this was recorded. Retrying is safe and will never issue twice."
                    : error.message}
                </span>
              </div>
            )}

            <DialogFooter>
              <Button type="button" variant="outline" size="lg" disabled={pending} onClick={onClose}>
                Cancel
              </Button>
              <Button ref={confirmRef} type="submit" size="lg" className="h-11 text-base" disabled={pending}>
                {pending ? <LoaderCircle className="animate-spin" /> : <CircleCheckBig />}
                {error?.uncertain ? "Retry" : `Issue ${row.couponQuantity} coupons`}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

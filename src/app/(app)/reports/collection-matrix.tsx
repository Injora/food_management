"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { Search } from "lucide-react";

import { NativeSelect } from "@/components/native-select";
import { Input } from "@/components/ui/input";
import { formatTime } from "@/lib/format";
import { MEAL_LABELS, MEAL_TYPES, type MealType } from "@/lib/meals";
import type { TeamWithMeals } from "@/server/services/teams";

const squash = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");

export function CollectionMatrix({ teams }: { teams: TeamWithMeals[] }) {
  const [query, setQuery] = useState("");
  const [pendingFor, setPendingFor] = useState<MealType | "">("");
  const [limit, setLimit] = useState(100);

  const visible = useMemo(() => {
    const qs = squash(query);
    return teams.filter(
      (t) =>
        (!qs || squash(t.teamName).includes(qs) || squash(t.teamCode).includes(qs) || squash(t.leaderName ?? "").includes(qs)) &&
        (!pendingFor || t.meals[pendingFor].status === "pending"),
    );
  }, [teams, query, pendingFor]);

  return (
    <div>
      <div className="flex flex-col gap-2 border-b p-3 sm:flex-row">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <Input aria-label="Search teams" placeholder="Search teams" className="pl-9" value={query} onChange={(e) => setQuery(e.target.value)} />
        </div>
        <NativeSelect aria-label="Show" className="sm:w-56" value={pendingFor} onChange={(e) => setPendingFor(e.target.value as MealType | "")}>
          <option value="">All teams</option>
          {MEAL_TYPES.map((m) => (
            <option key={m} value={m}>
              Pending for {MEAL_LABELS[m].toLowerCase()}
            </option>
          ))}
        </NativeSelect>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[40rem] text-sm">
          <thead className="bg-muted/50 text-left text-xs text-muted-foreground uppercase">
            <tr>
              <th scope="col" className="px-4 py-2 font-medium">Team</th>
              <th scope="col" className="px-4 py-2 text-right font-medium">Members</th>
              {MEAL_TYPES.map((m) => (
                <th key={m} scope="col" className="px-4 py-2 font-medium">{MEAL_LABELS[m]}</th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y">
            {visible.slice(0, limit).map((t) => (
              <tr key={t.id}>
                <td className="px-4 py-2">
                  <Link href={`/teams/${t.id}`} className="font-medium hover:underline">{t.teamName}</Link>{" "}
                  <span className="font-mono text-xs text-muted-foreground">{t.teamCode}</span>
                </td>
                <td className="tabular px-4 py-2 text-right">{t.memberCount}</td>
                {MEAL_TYPES.map((m) => {
                  const s = t.meals[m];
                  return (
                    <td key={m} className="tabular px-4 py-2 whitespace-nowrap">
                      {s.status === "issued" ? (
                        <span className="text-success-foreground">✓ {s.couponQuantity} at {formatTime(s.issuedAt)}</span>
                      ) : (
                        <span className="text-warning-foreground">Pending ({s.couponQuantity})</span>
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
            {visible.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-8 text-center text-muted-foreground">No teams match.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {visible.length > limit && (
        <div className="border-t p-3 text-center">
          <button type="button" className="text-sm font-medium text-primary hover:underline" onClick={() => setLimit((l) => l + 200)}>
            Show more ({visible.length - limit} remaining)
          </button>
        </div>
      )}
    </div>
  );
}

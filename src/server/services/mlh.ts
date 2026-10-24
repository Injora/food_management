import { asc, sql } from "drizzle-orm";
import { z } from "zod";

import type { Db, Executor } from "@/db";
import { mlhRegistrations } from "@/db/schema";
import type { MlhRow } from "@/lib/mlh";
import { assertPermission, type Actor } from "@/server/auth/permissions";
import { writeAudit } from "./audit";
import { parseInput } from "./validation";

export type MlhList = { rows: MlhRow[]; fileName: string | null; importedAt: string | null };

export async function getMlhList(exec: Executor, actor: Actor | null): Promise<MlhList> {
  assertPermission(actor, "teams:view");
  const rows = await exec.select().from(mlhRegistrations).orderBy(asc(mlhRegistrations.position));
  return {
    rows: rows.map((r) => ({ id: r.id, fullName: r.fullName, teamName: r.teamName, status: r.status })),
    fileName: rows[0]?.fileName ?? null,
    importedAt: rows[0]?.importedAt.toISOString() ?? null,
  };
}

const replaceSchema = z.object({
  fileName: z.string().trim().min(1).max(255),
  rows: z
    .array(
      z.object({
        fullName: z.string().trim().min(1).max(200),
        teamName: z.string().trim().max(200),
        status: z.string().trim().min(1).max(40),
      }),
    )
    .min(1, "The file has no registrations.")
    .max(20000, "The file has too many rows."),
});

/** Replaces the stored MLH list. Touches only mlh_registrations — never teams, participants or check-ins. */
export async function replaceMlhList(db: Db, actor: Actor | null, raw: unknown) {
  assertPermission(actor, "teams:import");
  const input = parseInput(replaceSchema, raw);
  return db.transaction(async (tx) => {
    const [{ before }] = await tx.select({ before: sql<number>`count(*)::int` }).from(mlhRegistrations);
    await tx.delete(mlhRegistrations);
    for (let i = 0; i < input.rows.length; i += 1000) {
      await tx.insert(mlhRegistrations).values(
        input.rows.slice(i, i + 1000).map((r, j) => ({ ...r, position: i + j, fileName: input.fileName, importedBy: actor.id })),
      );
    }
    const statuses: Record<string, number> = {};
    for (const r of input.rows) statuses[r.status] = (statuses[r.status] ?? 0) + 1;
    await writeAudit(tx, actor, {
      action: "mlh_import",
      before: { rows: before },
      after: { rows: input.rows.length, statuses },
      details: { fileName: input.fileName },
    });
    return { rows: input.rows.length, statuses };
  });
}

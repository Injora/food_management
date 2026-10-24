import { and, count, desc, eq, gte, type SQL } from "drizzle-orm";

import type { Executor } from "@/db";
import { auditLogs } from "@/db/schema";
import type { CouponType, SessionId } from "@/lib/domain";
import { assertPermission, type Actor } from "@/server/auth/permissions";

type AuditEntry = Omit<typeof auditLogs.$inferInsert, "id" | "createdAt" | "actorId" | "actorEmail">;

/** Always called inside the same transaction as the change it records. */
export async function writeAudit(exec: Executor, actor: Actor, entries: AuditEntry | AuditEntry[]) {
  const list = Array.isArray(entries) ? entries : [entries];
  if (list.length === 0) return;
  for (let i = 0; i < list.length; i += 1000) {
    await exec
      .insert(auditLogs)
      .values(list.slice(i, i + 1000).map((e) => ({ ...e, actorId: actor.id, actorEmail: actor.email })));
  }
}

export type AuditRow = {
  id: string;
  createdAt: string;
  actorEmail: string | null;
  action: (typeof auditLogs.$inferSelect)["action"];
  teamId: string | null;
  teamLabel: string | null;
  couponType: CouponType | null;
  sessionId: SessionId | null;
  reason: string | null;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  details: Record<string, unknown> | null;
};

export async function listAudit(
  exec: Executor,
  actor: Actor | null,
  opts: { teamId?: string; limit?: number; offset?: number; since?: Date } = {},
): Promise<{ rows: AuditRow[]; total: number }> {
  // A team's own history is visible to organizers; the full log is admin-only.
  assertPermission(actor, opts.teamId ? "teams:view" : "reports:view");
  const where: SQL | undefined = and(
    opts.teamId ? eq(auditLogs.teamId, opts.teamId) : undefined,
    opts.since ? gte(auditLogs.createdAt, opts.since) : undefined,
  );
  const [rows, [{ total }]] = await Promise.all([
    exec
      .select()
      .from(auditLogs)
      .where(where)
      .orderBy(desc(auditLogs.createdAt), desc(auditLogs.id))
      .limit(Math.min(opts.limit ?? 100, 100_000))
      .offset(opts.offset ?? 0),
    exec.select({ total: count() }).from(auditLogs).where(where),
  ]);
  return {
    total,
    rows: rows.map((r) => ({
      id: r.id,
      createdAt: r.createdAt.toISOString(),
      actorEmail: r.actorEmail,
      action: r.action,
      teamId: r.teamId,
      teamLabel: r.teamLabel,
      couponType: r.couponType,
      sessionId: r.sessionId,
      reason: r.reason,
      before: r.before ?? null,
      after: r.after ?? null,
      details: r.details ?? null,
    })),
  };
}

/** Latest desk activity for the overview screen (visible to volunteers). */
export async function listRecentActivity(exec: Executor, actor: Actor | null, limit = 12): Promise<AuditRow[]> {
  assertPermission(actor, "board:view");
  const rows = await exec.select().from(auditLogs).orderBy(desc(auditLogs.createdAt), desc(auditLogs.id)).limit(Math.min(limit, 50));
  return rows.map((r) => ({
    id: r.id,
    createdAt: r.createdAt.toISOString(),
    actorEmail: r.actorEmail,
    action: r.action,
    teamId: r.teamId,
    teamLabel: r.teamLabel,
    couponType: r.couponType,
    sessionId: r.sessionId,
    reason: r.reason,
    before: r.before ?? null,
    after: r.after ?? null,
    details: r.details ?? null,
  }));
}

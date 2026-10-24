import type { Metadata } from "next";

import { AutoRefresh } from "@/components/auto-refresh";
import { getDb } from "@/db";
import { isAdminRole } from "@/lib/domain";
import { requireActor } from "@/server/auth/current";
import { listRecentActivity } from "@/server/services/audit";
import { Overview } from "./overview";

export const metadata: Metadata = { title: "Overview" };

export default async function OverviewPage() {
  const actor = await requireActor();
  const activity = await listRecentActivity(getDb(), actor, 15);
  return (
    <>
      {/* Summary cards update from the live board; this refreshes the activity feed. */}
      <AutoRefresh seconds={10} />
      <Overview activity={activity} isAdmin={isAdminRole(actor.role)} />
    </>
  );
}

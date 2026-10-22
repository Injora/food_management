import type { Metadata } from "next";

import { PageHeader } from "@/components/page-header";
import { getDb } from "@/db";
import { can } from "@/server/auth/permissions";
import { requireActor } from "@/server/auth/current";
import { listTeams } from "@/server/services/teams";
import { NewTeamButton } from "./team-forms";
import { TeamsTable } from "./teams-table";

export const metadata: Metadata = { title: "Teams" };

export default async function TeamsPage() {
  const actor = await requireActor();
  const teams = await listTeams(getDb(), actor);
  const canEdit = can(actor, "teams:edit");
  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="Teams"
        description={`${teams.length} teams · ${teams.reduce((s, t) => s + t.memberCount, 0)} participants`}
        actions={canEdit && <NewTeamButton />}
      />
      <TeamsTable teams={teams} />
    </div>
  );
}

import type { Metadata } from "next";
import { Suspense } from "react";

import { getDb } from "@/db";
import { requireActor } from "@/server/auth/current";
import { can } from "@/server/auth/permissions";
import { listArchivedTeams } from "@/server/services/teams";
import { ArchivedTeams, NewTeamButton } from "./team-forms";
import { TeamsTable } from "./teams-table";

export const metadata: Metadata = { title: "Teams" };

export default async function TeamsPage() {
  const actor = await requireActor();
  const canEdit = can(actor, "teams:edit");
  const archived = canEdit ? await listArchivedTeams(await getDb(), actor) : [];
  return (
    <div className="flex flex-col gap-5">
      <Suspense>
        <TeamsTable actions={canEdit && <NewTeamButton />} />
      </Suspense>
      {canEdit && archived.length > 0 && <ArchivedTeams teams={archived} />}
    </div>
  );
}

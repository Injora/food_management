import type { Metadata } from "next";

import { Forbidden } from "@/components/forbidden";
import { PageHeader } from "@/components/page-header";
import { requireActor } from "@/server/auth/current";
import { can } from "@/server/auth/permissions";
import { ImportWizard } from "./import-wizard";

export const metadata: Metadata = { title: "CSV Import" };

export default async function ImportPage() {
  const actor = await requireActor();
  if (!can(actor, "teams:import")) return <Forbidden what="CSV import" />;
  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Import teams"
        description="Upload a team list or a registration export. Nothing is saved until you confirm, and existing teams are never duplicated."
      />
      <ImportWizard />
    </div>
  );
}

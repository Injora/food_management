import type { Metadata } from "next";

import { Forbidden } from "@/components/forbidden";
import { PageHeader } from "@/components/page-header";
import { requireActor } from "@/server/auth/current";
import { can } from "@/server/auth/permissions";
import { ImportWizard } from "./import-wizard";

export const metadata: Metadata = { title: "Registration import" };

export default async function ImportPage() {
  const actor = await requireActor();
  if (!can(actor, "teams:import")) return <Forbidden what="registration import" />;
  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Registration import"
        description="Upload the registration CSV or Excel file. Nothing is saved until you review and confirm. Re-importing never duplicates teams and never touches check-ins, coupons or room allocations."
      />
      <ImportWizard />
    </div>
  );
}

import type { Metadata } from "next";
import Link from "next/link";

import { Forbidden } from "@/components/forbidden";
import { PageHeader } from "@/components/page-header";
import { requireActor } from "@/server/auth/current";
import { can } from "@/server/auth/permissions";
import { SettingsForms } from "./settings-forms";

export const metadata: Metadata = { title: "Settings" };

export default async function SettingsPage() {
  const actor = await requireActor();
  if (!can(actor, "rooms:configure")) return <Forbidden what="settings" />;
  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Settings"
        description={
          <>
            Session times, room capacities and the overflow tolerance. Volunteer accounts are managed under{" "}
            <Link href="/admin/users" className="text-primary hover:underline">
              Volunteers
            </Link>
            .
          </>
        }
      />
      <SettingsForms />
    </div>
  );
}

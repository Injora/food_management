import type { Metadata } from "next";

import { Forbidden } from "@/components/forbidden";
import { PageHeader } from "@/components/page-header";
import { getDb } from "@/db";
import { requireActor } from "@/server/auth/current";
import { can } from "@/server/auth/permissions";
import { listUsers } from "@/server/services/users";
import { UsersManager } from "./users-manager";

export const metadata: Metadata = { title: "Volunteers" };

export default async function UsersPage() {
  const actor = await requireActor();
  if (!can(actor, "users:manage")) return <Forbidden what="volunteer management" />;
  const users = await listUsers(await getDb(), actor);
  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="Volunteers"
        description="Volunteers can check people in, issue coupons and allocate or move rooms. Admins can also import registrations, edit teams, revert coupons, change room capacities, view reports and manage accounts."
      />
      <UsersManager users={users} currentUserId={actor.id} canManageSuperadmins={can(actor, "superadmins:manage")} />
    </div>
  );
}

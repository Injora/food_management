import type { Metadata } from "next";

import { Forbidden } from "@/components/forbidden";
import { PageHeader } from "@/components/page-header";
import { getDb } from "@/db";
import { requireActor } from "@/server/auth/current";
import { can } from "@/server/auth/permissions";
import { listUsers } from "@/server/services/users";
import { UsersManager } from "./users-manager";

export const metadata: Metadata = { title: "Organizers" };

export default async function UsersPage() {
  const actor = await requireActor();
  if (!can(actor, "users:manage")) return <Forbidden what="organizer management" />;
  const users = await listUsers(getDb(), actor);
  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="Organizers"
        description="Organizers can search teams and issue coupons. Admins can also import, correct records, view reports and manage accounts."
      />
      <UsersManager users={users} currentUserId={actor.id} />
    </div>
  );
}

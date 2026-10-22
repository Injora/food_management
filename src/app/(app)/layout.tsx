import { AppShell } from "@/components/app-shell";
import { requireActor } from "@/server/auth/current";

export default async function AuthenticatedLayout({ children }: LayoutProps<"/">) {
  const actor = await requireActor();
  return <AppShell user={{ name: actor.name, email: actor.email, role: actor.role }}>{children}</AppShell>;
}

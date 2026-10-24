import { AppShell } from "@/components/app-shell";
import { BoardProvider } from "@/components/board-context";
import { TeamPanelProvider } from "@/components/team-panel";
import { getDb } from "@/db";
import { requireActor } from "@/server/auth/current";
import { loadBoard } from "@/server/services/board";

export default async function AuthenticatedLayout({ children }: LayoutProps<"/">) {
  const actor = await requireActor();
  const board = await loadBoard(getDb(), actor);
  return (
    <BoardProvider initial={board} viewer={{ name: actor.name, role: actor.role }}>
      <TeamPanelProvider>
        <AppShell user={{ name: actor.name, email: actor.email, role: actor.role }}>{children}</AppShell>
      </TeamPanelProvider>
    </BoardProvider>
  );
}

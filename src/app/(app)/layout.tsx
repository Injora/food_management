import { AppShell } from "@/components/app-shell";
import { BoardProvider } from "@/components/board-context";
import { TeamPanelProvider } from "@/components/team-panel";
import { activeDatabase, getDb } from "@/db";
import { formatTime } from "@/lib/format";
import { requireActor } from "@/server/auth/current";
import { loadBoard } from "@/server/services/board";

export default async function AuthenticatedLayout({ children }: LayoutProps<"/">) {
  const actor = await requireActor();
  const board = await loadBoard(await getDb(), actor);
  const active = await activeDatabase();
  return (
    <BoardProvider initial={board} viewer={{ name: actor.name, role: actor.role }}>
      <TeamPanelProvider>
        <AppShell user={{ name: actor.name, email: actor.email, role: actor.role }}>
          {active.target === "backup" && (
            <p role="status" className="mb-4 rounded-lg border border-warning bg-warning-soft px-3 py-2 text-sm text-warning-foreground">
              <span className="font-semibold">Running on the backup database</span>
              {active.since && ` since ${formatTime(active.since.toISOString())}`}. The main database stopped responding; anything entered in
              the few minutes before the switch may be missing.
            </p>
          )}
          {children}
        </AppShell>
      </TeamPanelProvider>
    </BoardProvider>
  );
}

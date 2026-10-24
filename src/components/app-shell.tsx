"use client";

import { LogOut, Menu, RefreshCw, Terminal, WifiOff } from "lucide-react";
import { useState } from "react";

import { AppNav } from "@/components/app-nav";
import { useBoard } from "@/components/board-context";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { ROLE_LABELS, type Role } from "@/lib/domain";
import { formatTime } from "@/lib/format";
import { logout } from "@/server/actions/auth";

type ShellUser = { name: string; email: string; role: Role };

function Brand() {
  return (
    <div className="flex items-center gap-2.5 px-3">
      <span className="flex size-8 items-center justify-center rounded-lg bg-primary text-primary-foreground">
        <Terminal className="size-4.5" aria-hidden />
      </span>
      <div className="leading-tight">
        <p className="text-sm font-semibold">Hack Day Ops</p>
        <p className="text-xs text-muted-foreground">Registration desk</p>
      </div>
    </div>
  );
}

/** Shows when the live data was last synced, and warns when it can't sync. */
function SyncStatus() {
  const { sync, refresh } = useBoard();
  return (
    <button
      type="button"
      onClick={() => void refresh()}
      className={`mx-3 flex items-center gap-1.5 rounded-md px-2 py-1 text-xs ${sync.offline ? "bg-destructive/10 font-semibold text-destructive" : "text-muted-foreground hover:bg-muted"}`}
      title="Live data refreshes every 4 seconds. Click to refresh now."
    >
      {sync.offline ? <WifiOff className="size-3.5" aria-hidden /> : <RefreshCw className="size-3.5" aria-hidden />}
      {sync.offline ? "Offline — showing last known data" : sync.at ? `Live · synced ${formatTime(sync.at.toISOString())}` : "Live"}
    </button>
  );
}

function UserFooter({ user }: { user: ShellUser }) {
  return (
    <div className="flex items-center gap-2 border-t px-3 pt-3">
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">{user.name}</p>
        <p className="truncate text-xs text-muted-foreground">{ROLE_LABELS[user.role]}</p>
      </div>
      <form action={logout}>
        <Button type="submit" variant="ghost" size="icon" aria-label="Sign out" title="Sign out">
          <LogOut />
        </Button>
      </form>
    </div>
  );
}

export function AppShell({ user, children }: { user: ShellUser; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="flex min-h-dvh">
      <aside className="sticky top-0 hidden h-dvh w-60 shrink-0 flex-col gap-6 border-r bg-sidebar py-4 lg:flex">
        <Brand />
        <div className="flex-1 overflow-y-auto px-2">
          <AppNav role={user.role} />
        </div>
        <SyncStatus />
        <UserFooter user={user} />
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex h-14 items-center gap-2 border-b bg-background/90 px-3 backdrop-blur lg:hidden">
          <Sheet open={open} onOpenChange={setOpen}>
            <SheetTrigger render={<Button variant="ghost" size="icon" aria-label="Open menu" />}>
              <Menu />
            </SheetTrigger>
            <SheetContent side="left" className="flex w-72 flex-col gap-6 bg-sidebar py-4">
              <SheetHeader className="p-0">
                <SheetTitle className="sr-only">Navigation</SheetTitle>
                <Brand />
              </SheetHeader>
              <div className="flex-1 overflow-y-auto px-2">
                <AppNav role={user.role} onNavigate={() => setOpen(false)} />
              </div>
              <UserFooter user={user} />
            </SheetContent>
          </Sheet>
          <Brand />
          <div className="ml-auto">
            <SyncStatus />
          </div>
        </header>
        <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-6 sm:px-6 lg:px-8">{children}</main>
      </div>
    </div>
  );
}

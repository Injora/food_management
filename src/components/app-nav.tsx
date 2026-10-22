"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ChartColumn, LayoutDashboard, Upload, UserCog, Users } from "lucide-react";
import { cn } from "cn";

import { MEAL_ICONS } from "@/components/meal-icon";
import { MEAL_LABELS, MEAL_TYPES, type Role } from "@/lib/meals";

type Item = { href: string; label: string; icon: React.ComponentType<{ className?: string }>; adminOnly?: boolean };

const SECTIONS: { title: string | null; items: Item[] }[] = [
  { title: null, items: [{ href: "/", label: "Dashboard", icon: LayoutDashboard }] },
  {
    title: "Distribute",
    items: MEAL_TYPES.map((m) => ({ href: `/meals/${m}`, label: MEAL_LABELS[m], icon: MEAL_ICONS[m] })),
  },
  {
    title: "Manage",
    items: [
      { href: "/teams", label: "Teams", icon: Users },
      { href: "/import", label: "CSV Import", icon: Upload, adminOnly: true },
      { href: "/reports", label: "Reports", icon: ChartColumn, adminOnly: true },
      { href: "/admin/users", label: "Organizers", icon: UserCog, adminOnly: true },
    ],
  },
];

export function AppNav({ role, onNavigate }: { role: Role; onNavigate?: () => void }) {
  const pathname = usePathname();
  const isActive = (href: string) => (href === "/" ? pathname === "/" : pathname === href || pathname.startsWith(`${href}/`));
  return (
    <nav aria-label="Main" className="flex flex-col gap-5">
      {SECTIONS.map((section) => {
        // Hiding links is a convenience only; the server enforces permissions.
        const items = section.items.filter((i) => !i.adminOnly || role === "admin");
        if (items.length === 0) return null;
        return (
          <div key={section.title ?? "root"}>
            {section.title && (
              <p className="mb-1.5 px-3 text-[11px] font-semibold tracking-wider text-muted-foreground uppercase">{section.title}</p>
            )}
            <ul className="flex flex-col gap-0.5">
              {items.map(({ href, label, icon: Icon }) => {
                const active = isActive(href);
                return (
                  <li key={href}>
                    <Link
                      href={href}
                      onClick={onNavigate}
                      aria-current={active ? "page" : undefined}
                      className={cn(
                        "flex h-10 items-center gap-3 rounded-lg px-3 text-sm font-medium transition-colors outline-none focus-visible:ring-3 focus-visible:ring-ring/50",
                        active ? "bg-accent text-accent-foreground" : "text-muted-foreground hover:bg-muted hover:text-foreground",
                      )}
                    >
                      <Icon className="size-4.5 shrink-0" />
                      {label}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        );
      })}
    </nav>
  );
}

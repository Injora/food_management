import { CircleCheckBig, Clock } from "lucide-react";
import { cn } from "cn";

import type { DistributionStatus } from "@/lib/meals";

export function StatusBadge({ status, size = "md", className }: { status: DistributionStatus; size?: "sm" | "md" | "lg"; className?: string }) {
  const issued = status === "issued";
  const Icon = issued ? CircleCheckBig : Clock;
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1.5 rounded-full border font-semibold whitespace-nowrap",
        issued
          ? "border-success/30 bg-success-soft text-success-foreground"
          : "border-warning/40 bg-warning-soft text-warning-foreground",
        size === "sm" && "px-2 py-0.5 text-xs [&_svg]:size-3.5",
        size === "md" && "px-2.5 py-1 text-sm [&_svg]:size-4",
        size === "lg" && "px-3.5 py-1.5 text-base [&_svg]:size-5",
        className,
      )}
    >
      <Icon aria-hidden />
      {issued ? "Issued" : "Pending"}
    </span>
  );
}

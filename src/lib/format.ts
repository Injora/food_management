const DEFAULT_TIME_ZONE = "Asia/Kolkata";

export function eventTimeZone(): string {
  const tz = process.env.NEXT_PUBLIC_EVENT_TIMEZONE || DEFAULT_TIME_ZONE;
  try {
    new Intl.DateTimeFormat("en", { timeZone: tz });
    return tz;
  } catch {
    return DEFAULT_TIME_ZONE;
  }
}

// Formatting with a fixed time zone keeps server and client renders identical.
const timeFmt = new Intl.DateTimeFormat("en-IN", { timeZone: eventTimeZone(), hour: "numeric", minute: "2-digit" });
const dateTimeFmt = new Intl.DateTimeFormat("en-IN", {
  timeZone: eventTimeZone(),
  day: "numeric",
  month: "short",
  hour: "numeric",
  minute: "2-digit",
  second: "2-digit",
});

export function formatTime(iso: string | null | undefined): string {
  return iso ? timeFmt.format(new Date(iso)) : "—";
}

export function formatDateTime(iso: string | null | undefined): string {
  return iso ? dateTimeFmt.format(new Date(iso)) : "—";
}

export const formatNumber = (n: number) => n.toLocaleString("en-IN");

export function formatPercent(fraction: number): string {
  return `${Math.round(fraction * 100)}%`;
}

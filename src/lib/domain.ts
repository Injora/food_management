export const ROLES = ["admin", "organizer", "superadmin"] as const;
export type Role = (typeof ROLES)[number];

/** UI names: "organizer" accounts are the volunteers working the desks. */
export const ROLE_LABELS: Record<Role, string> = { admin: "Admin", organizer: "Volunteer", superadmin: "Super admin" };

/** Super admins can do everything admins can, plus team evaluation. */
export const isAdminRole = (role: Role) => role === "admin" || role === "superadmin";

export const COUPON_TYPES = ["lunch", "snacks", "dinner"] as const;
export type CouponType = (typeof COUPON_TYPES)[number];

export const COUPON_LABELS: Record<CouponType, string> = {
  lunch: "Lunch",
  snacks: "Snacks",
  dinner: "Dinner",
};

export function isCouponType(value: unknown): value is CouponType {
  return typeof value === "string" && (COUPON_TYPES as readonly string[]).includes(value);
}

/** The two room-allocation sessions. They are independent of each other. */
export const SESSION_IDS = ["talks", "hackathon"] as const;
export type SessionId = (typeof SESSION_IDS)[number];

export const SESSION_LABELS: Record<SessionId, string> = {
  talks: "Open-source talks",
  hackathon: "Hackathon",
};

export function isSessionId(value: unknown): value is SessionId {
  return typeof value === "string" && (SESSION_IDS as readonly string[]).includes(value);
}

export type CheckInStatus = "none" | "partial" | "full";

export const CHECK_IN_LABELS: Record<CheckInStatus, string> = {
  none: "Not checked in",
  partial: "Partially checked in",
  full: "Checked in",
};

/** Derived purely from member records: 0/N, 1..N-1/N, N/N. */
export function checkInStatus(present: number, size: number): CheckInStatus {
  if (present <= 0 || size <= 0) return "none";
  return present >= size ? "full" : "partial";
}

export const formatParticipantCode = (no: number) => `P-${String(no).padStart(4, "0")}`;

import { AppError } from "@/lib/errors";
import type { Role } from "@/lib/domain";

export type Actor = { id: string; email: string; name: string; role: Role };

/**
 * "organizer" accounts are the desk volunteers; admins run the event; super
 * admins can do everything admins can, and only they can see evaluations or
 * manage other super admins.
 */
const PERMISSIONS = {
  "board:view": ["superadmin", "admin", "organizer"],
  "checkin:write": ["superadmin", "admin", "organizer"],
  // Volunteers fix their own desk mistakes; every undo is audited.
  "checkin:undo": ["superadmin", "admin", "organizer"],
  "coupons:issue": ["superadmin", "admin", "organizer"],
  "coupons:revert": ["superadmin", "admin"],
  "rooms:allocate": ["superadmin", "admin", "organizer"],
  "rooms:reassign": ["superadmin", "admin", "organizer"],
  "rooms:configure": ["superadmin", "admin"],
  "teams:view": ["superadmin", "admin", "organizer"],
  "teams:edit": ["superadmin", "admin"],
  "teams:import": ["superadmin", "admin"],
  "reports:view": ["superadmin", "admin"],
  "users:manage": ["superadmin", "admin"],
  "superadmins:manage": ["superadmin"],
  "eval:score": ["superadmin"],
} as const satisfies Record<string, readonly Role[]>;

export type Permission = keyof typeof PERMISSIONS;

export function can(actor: Actor | null | undefined, permission: Permission): boolean {
  return !!actor && (PERMISSIONS[permission] as readonly Role[]).includes(actor.role);
}

/** Every service calls this first, so no entry point can skip authorization. */
export function assertPermission(
  actor: Actor | null | undefined,
  permission: Permission,
): asserts actor is Actor {
  if (!actor) throw new AppError("UNAUTHORIZED", "Your session has expired. Please sign in again.");
  if (!can(actor, permission)) {
    throw new AppError("FORBIDDEN", "You don't have permission to do that. Ask an admin.");
  }
}

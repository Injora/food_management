import { AppError } from "@/lib/errors";
import type { Role } from "@/lib/meals";

export type Actor = { id: string; email: string; name: string; role: Role };

const PERMISSIONS = {
  "distribution:view": ["admin", "organizer"],
  "distribution:issue": ["admin", "organizer"],
  "distribution:correct": ["admin"],
  "teams:view": ["admin", "organizer"],
  "teams:edit": ["admin"],
  "teams:import": ["admin"],
  "reports:view": ["admin"],
  "users:manage": ["admin"],
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

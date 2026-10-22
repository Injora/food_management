import type { ActionResult } from "@/lib/errors";

/** Runs a Server Action and turns transport failures into a typed error. */
export async function callAction<T>(fn: () => Promise<ActionResult<T>>): Promise<ActionResult<T>> {
  try {
    return await fn();
  } catch {
    return {
      ok: false,
      error: { code: "NETWORK", message: "Network error: the server could not be reached. Check your connection and try again." },
    };
  }
}

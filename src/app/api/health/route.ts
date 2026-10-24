import { sql } from "drizzle-orm";
import { NextResponse } from "next/server";

import { getDb } from "@/db";

/**
 * Unauthenticated liveness check: reports only whether the database answers.
 * Reads a real table, so it also fails if pooled connections can't see the
 * app's tables (e.g. a search_path left behind by a maintenance tool).
 */
export async function GET() {
  try {
    await (await getDb()).execute(sql`select 1 from users limit 1`);
    return NextResponse.json({ ok: true, database: "up" }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ ok: false, database: "down" }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}

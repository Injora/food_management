import { sql } from "drizzle-orm";
import { NextResponse } from "next/server";

import { getDb } from "@/db";

/** Unauthenticated liveness check: reports only whether the database answers. */
export async function GET() {
  try {
    await (await getDb()).execute(sql`select 1`);
    return NextResponse.json({ ok: true, database: "up" }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ ok: false, database: "down" }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}

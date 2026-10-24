import { NextResponse } from "next/server";

import { HTTP_STATUS } from "@/lib/errors";
import { runAction } from "@/server/action-result";
import { loadBoard } from "@/server/services/board";

/** Polled by every desk screen so volunteers see each other's changes. */
export async function GET() {
  const result = await runAction((db, actor) => loadBoard(db, actor));
  return NextResponse.json(result, {
    status: result.ok ? 200 : HTTP_STATUS[result.error.code],
    headers: { "Cache-Control": "no-store" },
  });
}

import { NextResponse } from "next/server";

import { HTTP_STATUS } from "@/lib/errors";
import { runAction } from "@/server/action-result";
import { listEvaluations } from "@/server/services/evaluations";

/** Polled by the judging panel so judges see each other's marks. Super admins only. */
export async function GET(_req: Request, ctx: RouteContext<"/api/evaluations/[phase]">) {
  const { phase } = await ctx.params;
  const result = await runAction((db, actor) => listEvaluations(db, actor, phase));
  return NextResponse.json(result, {
    status: result.ok ? 200 : HTTP_STATUS[result.error.code],
    headers: { "Cache-Control": "no-store" },
  });
}

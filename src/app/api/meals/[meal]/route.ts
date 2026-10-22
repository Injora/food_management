import { NextResponse } from "next/server";

import { HTTP_STATUS } from "@/lib/errors";
import { runAction } from "@/server/action-result";
import { listMealDistribution } from "@/server/services/distribution";

/** Polled by the meal board so organizers see each other's issuances. */
export async function GET(_req: Request, ctx: RouteContext<"/api/meals/[meal]">) {
  const { meal } = await ctx.params;
  const result = await runAction((db, actor) => listMealDistribution(db, actor, meal));
  return NextResponse.json(result, {
    status: result.ok ? 200 : HTTP_STATUS[result.error.code],
    headers: { "Cache-Control": "no-store" },
  });
}

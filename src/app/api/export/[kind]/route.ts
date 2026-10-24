import { NextResponse } from "next/server";

import { toCsv } from "@/lib/csv";
import { HTTP_STATUS } from "@/lib/errors";
import { runAction } from "@/server/action-result";
import { buildExport } from "@/server/services/exports";

export async function GET(req: Request, ctx: RouteContext<"/api/export/[kind]">) {
  const { kind } = await ctx.params;
  const result = await runAction((db, actor) => buildExport(db, actor, kind, new URL(req.url).searchParams));
  if (!result.ok) {
    return NextResponse.json(result, { status: HTTP_STATUS[result.error.code], headers: { "Cache-Control": "no-store" } });
  }
  // BOM so Excel opens UTF-8 names correctly.
  return new NextResponse("﻿" + toCsv(result.data.rows), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${result.data.fileName}"`,
      "Cache-Control": "no-store",
    },
  });
}

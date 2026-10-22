"use server";

import { runAction } from "@/server/action-result";
import { analyzeImport, commitImport, type ImportRequest } from "@/server/services/import";

export async function analyzeImportAction(request: ImportRequest) {
  return runAction((db, actor) => analyzeImport(db, actor, request));
}

export async function commitImportAction(request: ImportRequest) {
  return runAction((db, actor) => commitImport(db, actor, request));
}

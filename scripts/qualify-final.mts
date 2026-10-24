/**
 * Puts the top teams of the mid evaluation into the final evaluation. Shows the
 * list first; nothing changes without --apply. Runs once, as a super admin.
 *   pnpm qualify:final [--top 40] [--exclude "TEAM RHOM"]... [--apply] [--as superadmin@email]
 */
import { parseArgs } from "node:util";
import { and, eq } from "drizzle-orm";

import { createDb } from "../src/db";
import { users } from "../src/db/schema";
import { FINALISTS, MID_RUBRIC, TRACK_LABELS } from "../src/lib/evaluation";
import { pickFinalists, qualifyFinalists } from "../src/server/services/evaluations";
import { requireEnv } from "./env";

const { values } = parseArgs({
  options: {
    top: { type: "string", default: String(FINALISTS) },
    exclude: { type: "string", multiple: true, default: [] },
    apply: { type: "boolean", default: false },
    as: { type: "string", default: "injoraman@gmail.com" },
  },
});
const input = { count: Number(values.top), exclude: values.exclude };

const { db, pool } = createDb(requireEnv("DATABASE_URL"), 1);
try {
  const [u] = await db.select().from(users).where(and(eq(users.email, values.as!.toLowerCase()), eq(users.active, true)));
  if (!u) throw new Error(`No active user ${values.as}`);
  const actor = { id: u.id, email: u.email, name: u.name, role: u.role };

  const finalists = values.apply ? await qualifyFinalists(db, actor, input) : await pickFinalists(db, actor, input);
  finalists.forEach((f, i) =>
    console.log(`${String(i + 1).padStart(2)}. ${f.teamName}  (mid #${f.midRank}, ${f.midTotal}/${MID_RUBRIC.totalMarks}, ${f.track ? TRACK_LABELS[f.track] : "no track"})`),
  );
  if (values.exclude!.length) console.log(`Left out: ${values.exclude!.join(", ")}`);
  console.log(values.apply ? `Added ${finalists.length} teams to the final evaluation.` : "Nothing changed. Run again with --apply to add these teams.");
} finally {
  await pool.end();
}

import { migrate } from "drizzle-orm/node-postgres/migrator";

import { createDb } from "../src/db";
import { requireEnv } from "./env";

// Never migrate through Neon's pooler: session settings made by a migration would stick
// to shared server connections the app reuses (see scripts/backup-db.sh).
const url = process.env.DATABASE_URL_UNPOOLED || requireEnv("DATABASE_URL").replace("-pooler.", ".");
const { db, pool } = createDb(url, 1);

try {
  await migrate(db, { migrationsFolder: "drizzle" });
  console.log("Migrations applied.");
} catch (err) {
  console.error("Migration failed:", err);
  process.exitCode = 1;
} finally {
  await pool.end();
}

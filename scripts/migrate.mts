import { migrate } from "drizzle-orm/node-postgres/migrator";

import { createDb } from "../src/db";
import { requireEnv } from "./env";

// Never migrate through Neon's pooler: session settings made by a migration would stick
// to shared server connections the app reuses (see scripts/backup-db.sh).
const pooled = requireEnv("DATABASE_URL");
const url = process.env.DATABASE_URL_UNPOOLED || pooled.replace("-pooler.", ".");

// .env.local can hold the production DATABASE_URL_UNPOOLED while DATABASE_URL is
// pointed elsewhere on the command line. Refuse rather than migrate the wrong database.
const target = (u: string) => {
  const { hostname, port, pathname } = new URL(u);
  return `${hostname.replace("-pooler.", ".")}:${port}${pathname}`;
};
if (target(url) !== target(pooled)) {
  console.error(`DATABASE_URL (${target(pooled)}) and DATABASE_URL_UNPOOLED (${target(url)}) are different databases. Set both, or unset DATABASE_URL_UNPOOLED.`);
  process.exit(1);
}
console.log(`Migrating ${target(url)}`);
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

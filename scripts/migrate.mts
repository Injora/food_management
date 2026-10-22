import { migrate } from "drizzle-orm/node-postgres/migrator";

import { createDb } from "../src/db";
import { requireEnv } from "./env";

const url = process.env.DATABASE_URL_UNPOOLED || requireEnv("DATABASE_URL");
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

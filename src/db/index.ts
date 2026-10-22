import { attachDatabasePool } from "@vercel/functions";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

import { AppError } from "@/lib/errors";
import * as schema from "./schema";

export type Db = NodePgDatabase<typeof schema>;
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
/** Either the root client or an open transaction. */
export type Executor = Db | Tx;

export function createDb(connectionString: string, max = 5) {
  const pool = new Pool({
    connectionString,
    max,
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 8_000,
  });
  // Without a listener an idle-client error (e.g. Neon scaling to zero)
  // would crash the process.
  pool.on("error", (err) => console.error("[db] idle client error", err));
  return { pool, db: drizzle(pool, { schema }) };
}

const globalForDb = globalThis as unknown as { __fmDb?: ReturnType<typeof createDb> };

/**
 * Shared pool for the app. With Neon, point DATABASE_URL at the pooled
 * (PgBouncer) endpoint; attachDatabasePool lets Vercel Fluid Compute close
 * idle connections before a function instance is suspended.
 */
export function getDb(): Db {
  if (!globalForDb.__fmDb) {
    const url = process.env.DATABASE_URL;
    if (!url) {
      throw new AppError(
        "DB_NOT_CONFIGURED",
        "DATABASE_URL is not set. Configure the Neon connection string and redeploy.",
      );
    }
    globalForDb.__fmDb = createDb(url);
    attachDatabasePool(globalForDb.__fmDb.pool);
  }
  return globalForDb.__fmDb.db;
}

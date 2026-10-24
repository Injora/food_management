import { attachDatabasePool } from "@vercel/functions";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool, type PoolConfig } from "pg";

import { AppError } from "@/lib/errors";
import * as schema from "./schema";
import { SUPABASE_ROOT_CA } from "./supabase-ca";

export type Db = NodePgDatabase<typeof schema>;
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
/** Either the root client or an open transaction. */
export type Executor = Db | Tx;

export function createDb(connectionString: string, max = 5, ssl?: PoolConfig["ssl"]) {
  const pool = new Pool({
    connectionString,
    ssl,
    max,
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 8_000,
  });
  // Without a listener an idle-client error (e.g. Neon scaling to zero)
  // would crash the process.
  pool.on("error", (err) => console.error("[db] idle client error", err));
  return { pool, db: drizzle(pool, { schema }) };
}

type Handle = ReturnType<typeof createDb>;
export type ActiveDatabase = { target: "primary" | "backup"; since: Date | null };

const PRIMARY: ActiveDatabase = { target: "primary", since: null };
/** How long an instance trusts its last read of the failover switch. */
const SWITCH_TTL_MS = 10_000;
const SWITCH_READ_TIMEOUT_MS = 2_500;

const globalForDb = globalThis as unknown as {
  __fmDb?: Handle;
  __fmBackupDb?: Handle | null;
  __fmActive?: { value: ActiveDatabase; checkedAt: number; pending?: Promise<ActiveDatabase> };
};

/**
 * Shared pool for the app. With Neon, point DATABASE_URL at the pooled
 * (PgBouncer) endpoint; attachDatabasePool lets Vercel Fluid Compute close
 * idle connections before a function instance is suspended.
 */
function primary(): Handle {
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
  return globalForDb.__fmDb;
}

/** The Supabase copy kept by scripts/backup-db.sh, or null when it isn't configured. */
function backup(): Handle | null {
  if (globalForDb.__fmBackupDb === undefined) {
    const raw = process.env.BACKUP_POSTGRES_URL;
    if (!raw) return (globalForDb.__fmBackupDb = null);
    // sslmode in the URL would override the ssl option; verify against Supabase's CA instead
    // (sslmode=disable is honoured for a local stand-in).
    const url = new URL(raw);
    const ssl = url.searchParams.get("sslmode") === "disable" ? false : { ca: SUPABASE_ROOT_CA, rejectUnauthorized: true };
    url.searchParams.delete("sslmode");
    globalForDb.__fmBackupDb = createDb(url.toString(), 5, ssl);
    attachDatabasePool(globalForDb.__fmBackupDb.pool);
  }
  return globalForDb.__fmBackupDb;
}

/** Reads the switch that scripts/watch-neon.sh flips when Neon stops answering. */
async function readSwitch(handle: Handle, fallback: ActiveDatabase): Promise<ActiveDatabase> {
  const timeout = new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timed out")), SWITCH_READ_TIMEOUT_MS));
  try {
    const { rows } = await Promise.race([
      handle.pool.query<{ active: string; switched_at: Date | null }>("select active, switched_at from backup_meta.failover where id = 1"),
      timeout,
    ]);
    return rows[0]?.active === "supabase" ? { target: "backup", since: rows[0].switched_at } : PRIMARY;
  } catch (err) {
    // Keep the last answer: if Supabase is unreachable it can't be serving the app either.
    console.error("[db] could not read the failover switch", err instanceof Error ? err.message || err.name : err);
    return fallback;
  }
}

/** Which database the app is using right now. */
export async function activeDatabase(): Promise<ActiveDatabase> {
  const handle = backup();
  if (!handle) return PRIMARY;
  const state = (globalForDb.__fmActive ??= { value: PRIMARY, checkedAt: 0 });
  if (Date.now() - state.checkedAt < SWITCH_TTL_MS) return state.value;
  state.pending ??= readSwitch(handle, state.value).then((value) => {
    if (value.target !== state.value.target) console.warn(`[db] now using the ${value.target} database`);
    Object.assign(state, { value, checkedAt: Date.now(), pending: undefined });
    return value;
  });
  return state.pending;
}

/** The database to use for this request: Neon, or Supabase while failed over. */
export async function getDb(): Promise<Db> {
  const active = await activeDatabase();
  return active.target === "backup" ? backup()!.db : primary().db;
}

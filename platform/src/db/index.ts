import pg from "pg";
import { env } from "../config/env.js";

const { Pool } = pg;

// Money is bigint in the schema; node-postgres hands back strings by default.
// Parse int8 to number — AED amounts in fils stay far inside Number.MAX_SAFE_INTEGER.
pg.types.setTypeParser(20, (v: string) => Number(v));
// numeric -> number (only used by aggregate reporting)
pg.types.setTypeParser(1700, (v: string) => Number(v));

let pool: pg.Pool | null = null;

export function getPool(): pg.Pool {
  if (!pool) {
    pool = new Pool({ connectionString: env().DATABASE_URL, max: 10, idleTimeoutMillis: 10_000 });
  }
  return pool;
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

export type Queryable = {
  query<T extends pg.QueryResultRow = any>(text: string, values?: unknown[]): Promise<pg.QueryResult<T>>;
};

/**
 * Run work with the connection pinned to one tenant. RLS reads app.tenant_id, so
 * anything this callback does is confined to that tenant even if a query forgets
 * its own WHERE clause. set_config(..., true) is transaction-local, so the setting
 * cannot leak to the next borrower of this connection.
 */
export async function withTenant<T>(tenantId: string, fn: (db: Queryable) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
    const out = await fn(client);
    await client.query("COMMIT");
    return out;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Cross-tenant access. Only two callers are legitimate: migrations, and the Kirmi
 * admin surface. Route handlers must go through withTenant instead.
 */
export async function withAdmin<T>(fn: (db: Queryable) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.bypass_rls', 'on', true)");
    const out = await fn(client);
    await client.query("COMMIT");
    return out;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/** Unscoped, non-transactional query for global tables (users, sessions, webhook_events). */
export async function query<T extends pg.QueryResultRow = any>(
  text: string,
  values?: unknown[],
): Promise<pg.QueryResult<T>> {
  return getPool().query<T>(text, values);
}

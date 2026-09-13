import { AsyncLocalStorage } from "node:async_hooks";
import type { Prisma, PrismaClient } from "@prisma/client";
import { env } from "../config/env.js";
import { TENANT_GUC } from "../config/constants.js";
import { TenantScopeError } from "../core/errors.js";
import { assertUuid } from "../core/ids.js";
import { prisma } from "./prisma.js";

/**
 * ===========================================================================
 * TENANT ISOLATION AT THE CONNECTION LAYER
 * ===========================================================================
 *
 * The guarantee this file implements: no query in this service can read or
 * write a row belonging to a client other than the one the current request is
 * for. Not "should not". Cannot, because Postgres refuses.
 *
 * How it works, in order:
 *
 *   1. Middleware resolves the clientId from the inbound request and opens an
 *      AsyncLocalStorage scope around the rest of the handler.
 *   2. Every database operation runs inside withTenant, which opens a
 *      transaction and issues set_config('app.current_client_id', <id>, true).
 *   3. The `true` makes it transaction local. It is discarded at COMMIT or
 *      ROLLBACK, so the setting cannot survive on a pooled connection and
 *      contaminate whoever borrows it next. This is the single most important
 *      character in this file.
 *   4. Row level security policies compare every row against that setting.
 *      Unset means NULL, NULL matches nothing, so an unscoped connection sees
 *      an empty database rather than everyone's.
 *
 * The application is therefore not the thing enforcing isolation. It is the
 * thing that declares which tenant it is acting as, and the database enforces
 * it. That distinction is why a bug in a service cannot become a data breach.
 */

/** The transaction handle every tenant scoped operation receives. */
export type TenantTx = Prisma.TransactionClient;

export interface TenantScope {
  clientId: string;
  requestId?: string;
}

const storage = new AsyncLocalStorage<TenantScope>();

/** Open a tenant scope for the duration of a callback. */
export function runInTenantScope<T>(scope: TenantScope, fn: () => T): T {
  assertUuid(scope.clientId, "clientId");
  return storage.run(scope, fn);
}

export function currentScope(): TenantScope | undefined {
  return storage.getStore();
}

/**
 * The clientId for the current request, or a hard failure.
 *
 * Throwing rather than returning undefined is deliberate. Code that reaches the
 * database without a tenant in scope has a bug in it, and the correct outcome
 * is a 500 and a stack trace, not a query that happens to return nothing.
 */
export function requireClientId(): string {
  const scope = storage.getStore();
  if (!scope) {
    throw new TenantScopeError("No tenant scope: a database call escaped the isolation middleware");
  }
  return scope.clientId;
}

export interface TenantTransactionOptions {
  /** Longer than the default for the reservation path, which takes row locks. */
  timeoutMs?: number;
  maxWaitMs?: number;
  isolationLevel?: Prisma.TransactionIsolationLevel;
}

export interface TenantDatabase {
  withTenant<T>(clientId: string, fn: (tx: TenantTx) => Promise<T>, options?: TenantTransactionOptions): Promise<T>;
  withCurrentTenant<T>(fn: (tx: TenantTx) => Promise<T>, options?: TenantTransactionOptions): Promise<T>;
  raw(): PrismaClient;
}

/**
 * Run work with the connection pinned to one tenant.
 *
 * Everything inside the callback is confined to that tenant even if a query
 * forgets its own WHERE clause, because row level security is applying the
 * filter underneath.
 */
export async function withTenant<T>(
  clientId: string,
  fn: (tx: TenantTx) => Promise<T>,
  options: TenantTransactionOptions = {},
): Promise<T> {
  // Validated before it goes anywhere near SQL. The set_config call below binds
  // it as a parameter, so this is belt and braces rather than the only defence,
  // but a non-uuid here means the caller is holding the wrong value entirely.
  const scopedId = assertUuid(clientId, "clientId");
  const config = env();

  return prisma().$transaction(
    async (tx) => {
      // Transaction local. Discarded on COMMIT or ROLLBACK, so it cannot leak
      // to the next borrower of this pooled connection.
      await tx.$executeRaw`SELECT set_config(${TENANT_GUC}, ${scopedId}, true)`;

      // A runaway query holding a row lock is how a reservation path turns into
      // an outage. Postgres kills it rather than the SLA dying quietly.
      await tx.$executeRawUnsafe(`SET LOCAL statement_timeout = ${config.DATABASE_STATEMENT_TIMEOUT_MS}`);

      return fn(tx);
    },
    {
      timeout: options.timeoutMs ?? 10_000,
      maxWait: options.maxWaitMs ?? 5_000,
      ...(options.isolationLevel ? { isolationLevel: options.isolationLevel } : {}),
    },
  );
}

/** Same, for the tenant already in AsyncLocalStorage. The common case. */
export async function withCurrentTenant<T>(
  fn: (tx: TenantTx) => Promise<T>,
  options: TenantTransactionOptions = {},
): Promise<T> {
  return withTenant(requireClientId(), fn, options);
}

/**
 * The injectable form. Services take this interface rather than importing the
 * functions directly, so a unit test hands them an in memory double and never
 * needs a database at all.
 */
export const tenantDatabase: TenantDatabase = {
  withTenant,
  withCurrentTenant,
  raw: prisma,
};

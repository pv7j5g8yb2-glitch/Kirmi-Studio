import { PrismaClient } from "@prisma/client";
import { env } from "../config/env.js";
import { logger } from "../core/logger.js";

/**
 * The Prisma client singleton.
 *
 * One instance per process. Prisma owns a connection pool internally, and a
 * second client means a second pool, which on a queue worker box quietly
 * doubles the connection count until Postgres starts refusing.
 */

let client: PrismaClient | null = null;

/** Put the configured pool size on the URL without clobbering existing params. */
function withPoolSettings(url: string, poolSize: number): string {
  try {
    const parsed = new URL(url);
    if (!parsed.searchParams.has("connection_limit")) {
      parsed.searchParams.set("connection_limit", String(poolSize));
    }
    if (!parsed.searchParams.has("pool_timeout")) {
      parsed.searchParams.set("pool_timeout", "10");
    }
    return parsed.toString();
  } catch {
    // A URL Prisma accepts but WHATWG URL does not: hand it through untouched
    // rather than mangling a working connection string.
    return url;
  }
}

export function prisma(): PrismaClient {
  if (client) return client;

  const config = env();
  client = new PrismaClient({
    datasources: { db: { url: withPoolSettings(config.DATABASE_URL, config.DATABASE_POOL_SIZE) } },
    log:
      config.LOG_LEVEL === "debug" || config.LOG_LEVEL === "trace"
        ? [{ emit: "event", level: "query" }, { emit: "event", level: "warn" }, { emit: "event", level: "error" }]
        : [{ emit: "event", level: "warn" }, { emit: "event", level: "error" }],
  });

  // Prisma's own logs go through pino so they carry the same redaction and the
  // same structure as everything else, instead of landing on stdout raw.
  client.$on("warn" as never, (e: unknown) => logger().warn({ prisma: e }, "prisma warning"));
  client.$on("error" as never, (e: unknown) => logger().error({ prisma: e }, "prisma error"));

  return client;
}

export async function disconnectPrisma(): Promise<void> {
  if (client) {
    await client.$disconnect();
    client = null;
  }
}

/** Test seam: swap in a client pointed at a throwaway database. */
export function setPrismaForTesting(instance: PrismaClient | null): void {
  client = instance;
}

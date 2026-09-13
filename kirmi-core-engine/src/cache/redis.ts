import { Redis } from "ioredis";
import { env } from "../config/env.js";
import { logger } from "../core/logger.js";

/**
 * Redis connections.
 *
 * Two of them, on purpose. BullMQ needs a connection with
 * maxRetriesPerRequest set to null because its blocking commands park on the
 * socket for minutes at a time; the cache needs the opposite, a connection that
 * gives up quickly so a Redis wobble degrades a reply from fast to slow rather
 * than hanging the request until the SLA is gone.
 */

let cacheClient: Redis | null = null;
let queueClient: Redis | null = null;

function build(role: "cache" | "queue"): Redis {
  const config = env();
  const client = new Redis(config.REDIS_URL, {
    // Namespacing differs by role, and this is not cosmetic. BullMQ refuses an
    // ioredis connection that carries a keyPrefix, because it builds its own
    // keys and a client side prefix silently breaks its Lua scripts. It takes a
    // `prefix` option on the Queue and Worker instead, which queues.ts sets.
    ...(role === "cache" ? { keyPrefix: `${config.REDIS_KEY_PREFIX}:` } : {}),
    lazyConnect: false,
    // The cache must fail fast: it sits inside the latency budget for a reply.
    // The queue must not: blocking pops legitimately wait a long time.
    maxRetriesPerRequest: role === "queue" ? null : 2,
    enableReadyCheck: true,
    connectTimeout: 5_000,
    retryStrategy: (attempt) => Math.min(attempt * 200, 3_000),
  });

  client.on("error", (err: Error) => {
    logger().error({ err, role }, "redis connection error");
  });

  return client;
}

/** Hot path cache. Losing this degrades latency; it must never lose data. */
export function redis(): Redis {
  if (!cacheClient) cacheClient = build("cache");
  return cacheClient;
}

/** Dedicated connection for BullMQ. */
export function queueRedis(): Redis {
  if (!queueClient) queueClient = build("queue");
  return queueClient;
}

export async function disconnectRedis(): Promise<void> {
  await Promise.allSettled([cacheClient?.quit(), queueClient?.quit()]);
  cacheClient = null;
  queueClient = null;
}

/** Test seam. */
export function setRedisForTesting(instance: Redis | null): void {
  cacheClient = instance;
}

import { Worker } from "bullmq";
import { QUEUE_NAMES } from "../../config/constants.js";
import { env } from "../../config/env.js";
import { queueRedis } from "../../cache/redis.js";
import type { Container } from "../../core/container.js";
import type { HoldSweeperJob } from "../jobs.js";

/**
 * Releases holds nobody completed.
 *
 * Unglamorous and directly revenue affecting. An expired hold that is never
 * swept is a car that cannot be sold to anybody, and on a small luxury fleet
 * one stuck Urus for a weekend is a five figure hole.
 *
 * The tenant list comes from the routing projection, then each client is swept
 * inside its own scope. One client's failure does not stop the others, because
 * the alternative is one bad configuration freezing the whole fleet's inventory.
 */
export function createHoldSweeperWorker(container: Container): Worker<HoldSweeperJob> {
  return new Worker<HoldSweeperJob>(
    QUEUE_NAMES.holdSweeper,
    async (job) => {
      const explicit = job.data.clientId;
      const clientIds = explicit ? [explicit] : await container.config.listActiveClientIds();

      let released = 0;
      for (const clientId of clientIds) {
        try {
          released += await container.reservations.sweepExpiredHolds(clientId);
        } catch (err) {
          container.log.error({ err, clientId }, "hold sweep failed for one client, continuing with the rest");
        }
      }

      if (released > 0) container.log.info({ released, tenants: clientIds.length }, "expired holds released");
    },
    {
      connection: queueRedis(),
      prefix: `${env().REDIS_KEY_PREFIX}:bull`,
      concurrency: 1,
    },
  );
}

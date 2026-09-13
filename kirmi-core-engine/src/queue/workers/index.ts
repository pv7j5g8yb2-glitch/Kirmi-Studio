import { disconnectRedis } from "../../cache/redis.js";
import { buildContainer } from "../../core/container.js";
import { logger } from "../../core/logger.js";
import { disconnectPrisma } from "../../db/prisma.js";
import { closeQueues } from "../queues.js";
import { createHoldSweeperWorker } from "./hold-sweeper.worker.js";
import { createOutboundDeliveryWorker } from "./outbound-delivery.worker.js";
import { createWebhookIngestWorker } from "./webhook-ingest.worker.js";

/**
 * The worker process.
 *
 * Same image and the same container wiring as the API, minus the HTTP server
 * and the socket, so escalations raised here are persisted but not pushed. That
 * is correct: the API process holds the dashboard sockets and will deliver the
 * backlog when a dashboard reconnects.
 *
 * Deployed as its own set of pods so a slow LLM call or a retry storm never
 * competes with a webhook acknowledgement for the event loop.
 */
async function main(): Promise<void> {
  const log = logger();
  const container = buildContainer();

  const workers = [
    createWebhookIngestWorker(container),
    createOutboundDeliveryWorker(container),
    createHoldSweeperWorker(container),
  ];

  for (const worker of workers) {
    worker.on("failed", (job, err) => {
      log.error({ err, jobId: job?.id, queue: worker.name, attempts: job?.attemptsMade }, "job failed");
    });
    worker.on("error", (err) => log.error({ err, queue: worker.name }, "worker error"));
  }

  log.info({ queues: workers.map((w) => w.name) }, "workers running");

  const shutdown = async (): Promise<void> => {
    log.info("draining workers");
    // close() waits for in flight jobs rather than killing them, so a customer
    // mid conversation still gets their reply during a deploy.
    await Promise.allSettled(workers.map((w) => w.close()));
    await closeQueues();
    await disconnectPrisma();
    await disconnectRedis();
    log.info("workers stopped");
  };

  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.once(signal, () => {
      void shutdown().then(
        () => process.exit(0),
        () => process.exit(1),
      );
    });
  }
}

main().catch((err: unknown) => {
  logger().fatal({ err }, "worker process failed to start");
  process.exit(1);
});

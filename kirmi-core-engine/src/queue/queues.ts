import { Queue, type JobsOptions } from "bullmq";
import { QUEUE_NAMES, type QueueName } from "../config/constants.js";
import { env } from "../config/env.js";
import { logger } from "../core/logger.js";
import { queueRedis } from "../cache/redis.js";
import type { JobPayloads } from "./jobs.js";

/**
 * ===========================================================================
 * THE DECOUPLED QUEUE LAYER
 * ===========================================================================
 *
 * Why anything is queued at all: Meta expects a 200 from a webhook in a couple
 * of seconds and retries the delivery if it does not get one. Doing the real
 * work inline means a slow LLM call or a slow database turns into duplicate
 * deliveries of the same message, which is the exact failure the idempotency
 * layer then has to clean up.
 *
 * So the route does the minimum that must be synchronous, verify the signature,
 * claim the idempotency key, persist the raw event, then hands off and returns
 * 200. Everything after that happens here, where a retry is cheap and a slow
 * step costs latency rather than correctness.
 */

const queues = new Map<QueueName, Queue>();

/** Retries with backoff, because carriers and payment gateways fail transiently. */
const DEFAULT_JOB_OPTIONS: JobsOptions = {
  attempts: 5,
  backoff: { type: "exponential", delay: 1_000 },
  // Completed jobs are trimmed aggressively, failures are kept for a week:
  // nobody debugs a success, and a failed enquiry is lost revenue worth reading.
  removeOnComplete: { age: 3_600, count: 1_000 },
  removeOnFail: { age: 7 * 24 * 3_600 },
};

/**
 * A narrow port over BullMQ's Queue.
 *
 * Two reasons it exists rather than exposing Queue directly. It keeps the
 * payload type checked at every call site, which BullMQ's own conditional
 * generics lose once the queue name is itself generic. And it is the seam a
 * unit test replaces with an array, so testing "does this enqueue a job" needs
 * no Redis.
 */
export interface TypedQueue<N extends QueueName> {
  add(jobName: string, data: JobPayloads[N], opts?: JobsOptions): Promise<unknown>;
  close(): Promise<void>;
}

export function queue<N extends QueueName>(name: N): TypedQueue<N> {
  const existing = queues.get(name);
  if (existing) return existing as unknown as TypedQueue<N>;

  const created = new Queue(name, {
    connection: queueRedis(),
    prefix: `${env().REDIS_KEY_PREFIX}:bull`,
    defaultJobOptions: DEFAULT_JOB_OPTIONS,
  });
  queues.set(name, created);
  return created as unknown as TypedQueue<N>;
}

/**
 * Enqueue with a deduplication id.
 *
 * BullMQ treats an explicit jobId as unique while the job is live, which gives
 * a second, independent layer of duplicate protection behind the Redis
 * interceptor. Belt and braces on the one path where a duplicate costs money.
 */
export async function enqueue<N extends QueueName>(
  name: N,
  payload: JobPayloads[N],
  options: JobsOptions & { dedupeId?: string } = {},
): Promise<void> {
  const { dedupeId, ...jobOptions } = options;
  await queue(name).add(name, payload, {
    ...jobOptions,
    ...(dedupeId ? { jobId: dedupeId } : {}),
  });
}

/**
 * The hold sweeper is the only scheduled job. An abandoned hold is a car
 * withdrawn from sale, so nothing is more directly revenue destroying than a
 * sweeper that is not running.
 */
export async function scheduleRecurringJobs(): Promise<void> {
  await queue(QUEUE_NAMES.holdSweeper).add(
    QUEUE_NAMES.holdSweeper,
    {},
    {
      repeat: { pattern: "* * * * *" }, // every minute
      jobId: "hold-sweeper-tick",
      removeOnComplete: { count: 10 },
    },
  );
  logger().info("recurring jobs scheduled");
}

export async function closeQueues(): Promise<void> {
  await Promise.allSettled([...queues.values()].map((q) => q.close()));
  queues.clear();
}

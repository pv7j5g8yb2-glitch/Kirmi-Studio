import { Worker } from "bullmq";
import { QUEUE_NAMES } from "../../config/constants.js";
import { env } from "../../config/env.js";
import { queueRedis } from "../../cache/redis.js";
import type { Container } from "../../core/container.js";
import { TransientDeliveryError } from "../../channels/types.js";
import type { OutboundDeliveryJob } from "../jobs.js";

/**
 * ===========================================================================
 * OUTBOUND DELIVERY
 * ===========================================================================
 *
 * The last step: the reply the engine composed actually reaching the customer.
 *
 * Queued rather than sent inline because the message is already recorded in
 * Postgres by the time this runs. That ordering matters. If we sent first and
 * recorded second, a crash between the two would leave a customer holding a
 * message the system has no memory of, and the next reply would repeat itself
 * or contradict it.
 *
 * Failures split two ways. A timeout, a 429 or a 5xx is transient and thrown,
 * so BullMQ retries with backoff. A refusal from Meta is not retried: the
 * message itself is the problem, and the right response is to tell a human
 * rather than to try four more times.
 */
export function createOutboundDeliveryWorker(container: Container): Worker<OutboundDeliveryJob> {
  return new Worker<OutboundDeliveryJob>(
    QUEUE_NAMES.outboundDelivery,
    async (job) => {
      const { clientId, conversationId, messageId, channel, to, body } = job.data;
      const log = container.log.child({ clientId, conversationId, messageId, channel });

      const provider = container.channels.get(channel);
      if (!provider) {
        log.error({ channel }, "no provider registered for this channel, message cannot be delivered");
        return;
      }

      try {
        const result = await provider.send(clientId, { to, body, correlationId: messageId });

        if (!result.accepted) {
          // The carrier refused. A person needs to know, because the customer
          // is sitting there having received nothing.
          log.error({ rejection: result.rejection }, "carrier refused the message");
          const tenant = await container.config.loadProfile(clientId);
          await container.escalations.escalate({
            tenant,
            conversationId,
            reason: "LOW_CONFIDENCE",
            summary: `The reply could not be delivered: ${result.rejection ?? "carrier refused it"}`,
            context: { messageId, channel, to },
          });
          return;
        }

        // Store the carrier's id so delivery receipts can be matched back.
        await container.db.withTenant(clientId, async (tx) => {
          await tx.message.update({
            where: { id: messageId },
            data: { providerMessageId: result.providerMessageId, meta: { deliveredAt: new Date().toISOString() } },
          });
        });

        log.debug({ providerMessageId: result.providerMessageId }, "reply delivered");
      } catch (err) {
        if (err instanceof TransientDeliveryError) {
          log.warn({ err, attempt: job.attemptsMade }, "transient delivery failure, will retry");
          throw err;
        }
        log.error({ err }, "delivery failed");
        throw err;
      }
    },
    {
      connection: queueRedis(),
      prefix: `${env().REDIS_KEY_PREFIX}:bull`,
      concurrency: 10,
      // Meta rate limits per phone number. Staying under it deliberately is
      // better than discovering the limit during a client's busiest hour.
      limiter: { max: 60, duration: 1_000 },
    },
  );
}

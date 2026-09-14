import { Worker } from "bullmq";
import { QUEUE_NAMES } from "../../config/constants.js";
import { env } from "../../config/env.js";
import { queueRedis } from "../../cache/redis.js";
import type { Container } from "../../core/container.js";
import { TransientDeliveryError, WHATSAPP_UNREACHABLE_CODES } from "../../channels/types.js";
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
      const { clientId, conversationId, messageId, channel, to, body, media, template, allowSmsFallback } = job.data;
      const log = container.log.child({ clientId, conversationId, messageId, channel });

      const provider = container.channels.get(channel);
      if (!provider) {
        log.error({ channel }, "no provider registered for this channel, message cannot be delivered");
        return;
      }

      try {
        const result = await provider.send(clientId, {
          to,
          body,
          correlationId: messageId,
          ...(media?.length ? { media } : {}),
          ...(template ? { template } : {}),
        });

        // WhatsApp taking one attachment per message is a carrier constraint,
        // not ours, so a set of photographs is a short sequence of sends. The
        // first carries the caption; the rest are bare images following it.
        if (result.accepted && media && media.length > 1) {
          for (const extra of media.slice(1)) {
            try {
              await provider.send(clientId, { to, body: "", correlationId: messageId, media: [extra] });
            } catch (err) {
              // One photograph failing is not worth failing the reply that
              // already arrived, and retrying the job would resend the first.
              log.warn({ err, url: extra.url }, "a follow-on attachment did not send");
            }
          }
        }

        if (!result.accepted) {
          // The number is not on WhatsApp at all. On a proactive send that is
          // exactly what SMS is for: a missed call from a number with no
          // WhatsApp is otherwise a dead end, and a dead end at a luxury desk
          // is a four figure loss.
          if (allowSmsFallback && shouldTrySms(result.rejectionCode)) {
            const delivered = await trySms(container, clientId, conversationId, messageId, to, body);
            if (delivered) {
              log.info({ to }, "whatsapp was unreachable, delivered by sms instead");
              return;
            }
          }

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

function shouldTrySms(code: number | undefined): boolean {
  // An unknown refusal is NOT an SMS case. Falling back on every failure would
  // turn a malformed template into a surprise text message, billed per segment.
  return typeof code === "number" && WHATSAPP_UNREACHABLE_CODES.has(code);
}

/**
 * Send the same thing as a text message, and record it as its own outbound.
 *
 * A separate message row rather than an update, because it genuinely is one:
 * it went to a different channel, it has a different carrier id, and the
 * transcript should show a human reading it that the WhatsApp attempt failed
 * and a text followed.
 */
async function trySms(
  container: Container,
  clientId: string,
  conversationId: string,
  originalMessageId: string,
  to: string,
  body: string,
): Promise<boolean> {
  const tenant = await container.config.loadProfile(clientId);
  if (!tenant.proactive.smsFallbackEnabled) return false;

  const sms = container.channels.get("SMS");
  if (!sms) return false;

  try {
    const result = await sms.send(clientId, { to, body, correlationId: originalMessageId });
    if (!result.accepted) return false;

    await container.db.withTenant(clientId, async (tx) => {
      await tx.message.create({
        data: {
          clientId,
          conversationId,
          direction: "OUTBOUND",
          channel: "SMS",
          body,
          providerMessageId: result.providerMessageId,
          meta: { smsFallbackFor: originalMessageId },
        },
      });
    });
    return true;
  } catch (err) {
    container.log.warn({ err, clientId, to }, "sms fallback failed too");
    return false;
  }
}

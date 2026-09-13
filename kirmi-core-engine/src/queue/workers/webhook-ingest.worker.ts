import type { ChannelType } from "@prisma/client";
import { Worker } from "bullmq";
import { QUEUE_NAMES } from "../../config/constants.js";
import { env } from "../../config/env.js";
import { queueRedis } from "../../cache/redis.js";
import type { Container } from "../../core/container.js";
import type { MetaWebhookBody } from "../../middleware/tenant-isolation.middleware.js";
import type { InboundMessage } from "../../orchestrator/message.pipeline.js";
import type { WebhookIngestJob } from "../jobs.js";

/**
 * ===========================================================================
 * WEBHOOK INGEST WORKER
 * ===========================================================================
 *
 * Where a carrier payload becomes a reply.
 *
 * The job carries an id, not a payload: the raw event was persisted by the
 * route, so this worker reads it back rather than trusting anything that
 * travelled through Redis. If the queue is lost, the events are still in
 * Postgres and can be replayed.
 *
 * Every job opens its own tenant scope from job.data.clientId. That is not
 * optional: AsyncLocalStorage is empty out here, and a database call without a
 * scope sees an empty database rather than raising, so a worker that forgot
 * would silently succeed at doing nothing.
 */
export function createWebhookIngestWorker(container: Container): Worker<WebhookIngestJob> {
  return new Worker<WebhookIngestJob>(
    QUEUE_NAMES.webhookIngest,
    async (job) => {
      const { clientId, provider, webhookEventId, receivedAtIso } = job.data;
      const log = container.log.child({ clientId, provider, webhookEventId, jobId: job.id });

      const event = await container.webhooks.load(clientId, webhookEventId);
      if (!event) {
        log.warn("webhook event row is gone, nothing to process");
        return;
      }

      const tenant = await container.config.loadProfile(clientId);
      const receivedAt = new Date(receivedAtIso);

      try {
        const inbound =
          provider === "meta"
            ? extractMetaMessage(event.payload as MetaWebhookBody, receivedAt)
            : extractTwilioTrigger(event.payload as Record<string, string>, receivedAt);

        if (!inbound) {
          // Delivery receipts, read receipts, ringing callbacks. Real traffic,
          // nothing to answer. Marked processed so it is not retried forever.
          log.debug("no actionable message in this delivery");
          await container.webhooks.markProcessed(clientId, webhookEventId);
          return;
        }

        const result = await container.pipeline.handle(tenant, inbound);

        log.info(
          { status: result.status, latencyMs: Math.round(result.latencyMs), slaBreached: result.slaBreached },
          "inbound message handled",
        );

        if (result.slaBreached) {
          log.warn({ latencyMs: Math.round(result.latencyMs), budgetMs: env().REPLY_SLA_MS }, "SLA breached on this reply");
        }

        await container.webhooks.markProcessed(clientId, webhookEventId);
      } catch (err) {
        await container.webhooks.markFailed(clientId, webhookEventId, err instanceof Error ? err.message : String(err));

        // Hand the idempotency key back so the carrier's retry is allowed
        // through. Holding it would turn a transient failure into a permanently
        // lost enquiry, which is the more expensive of the two mistakes.
        const externalId = event.externalEventId;
        await container.idempotency.release(clientId, provider, externalId);

        throw err;
      }
    },
    {
      connection: queueRedis(),
      prefix: `${env().REDIS_KEY_PREFIX}:bull`,
      // Enough parallelism to absorb a burst, low enough that one tenant's
      // spike cannot monopolise the database connection pool.
      concurrency: 8,
    },
  );
}

/** The one text message in a Meta payload, if there is one. */
function extractMetaMessage(body: MetaWebhookBody, receivedAt: Date): InboundMessage | null {
  const entry = body.entry?.[0];

  const whatsapp = entry?.changes?.[0]?.value;
  const message = whatsapp?.messages?.[0];
  if (message?.id && message.from) {
    const text = message.text?.body;
    // Images, voice notes and locations arrive here too. They are real
    // enquiries and worth a reply, so they are passed through with a marker
    // rather than dropped.
    return {
      channel: "WHATSAPP" as ChannelType,
      externalId: message.from,
      ...(whatsapp?.contacts?.[0]?.profile?.name ? { displayName: whatsapp.contacts[0].profile.name } : {}),
      providerMessageId: message.id,
      body: text ?? `[${message.type ?? "media"} message]`,
      receivedAt,
    };
  }

  const instagram = entry?.messaging?.[0];
  if (instagram?.message?.mid && instagram.sender?.id) {
    return {
      channel: "INSTAGRAM" as ChannelType,
      externalId: instagram.sender.id,
      providerMessageId: instagram.message.mid,
      body: instagram.message.text ?? "[media message]",
      receivedAt,
    };
  }

  return null;
}

/**
 * A missed call becomes a message.
 *
 * Only genuinely missed calls qualify. A completed call has already been
 * handled by a person, and following it up with an automated "sorry we missed
 * you" is worse than staying quiet.
 */
function extractTwilioTrigger(body: Record<string, string>, receivedAt: Date): InboundMessage | null {
  const status = body["CallStatus"];
  const from = body["From"];
  const sid = body["CallSid"];

  if (!from || !sid) return null;
  if (!["no-answer", "busy", "failed", "canceled"].includes(status ?? "")) return null;

  return {
    channel: "WHATSAPP" as ChannelType,
    externalId: from.replace(/^tel:/, ""),
    providerMessageId: `${sid}:missed`,
    // Phrased as the customer's own intent so the agent opens the conversation
    // naturally rather than reading out a system event.
    body: "[missed call] The customer just rang and nobody picked up. Open with an apology for missing them and ask what they are looking for.",
    receivedAt,
  };
}

import { Worker } from "bullmq";
import { QUEUE_NAMES } from "../../config/constants.js";
import { env } from "../../config/env.js";
import { queueRedis } from "../../cache/redis.js";
import type { Container } from "../../core/container.js";
import { formatMoney } from "../../core/money.js";
import { composeFollowUp, nextAllowedTime } from "../../services/follow-up.service.js";
import type { FollowUpSweeperJob } from "../jobs.js";

/**
 * ===========================================================================
 * THE CHASE
 * ===========================================================================
 *
 * Every few minutes, look for customers who went quiet and say one more thing
 * to them. That is the entire worker, and it is the single largest conversion
 * lever in the product.
 *
 * Three refusals are built in, and each one exists because the alternative
 * loses the client rather than gains a booking:
 *
 *   The conversation is in human hands   -> skip. Somebody is on it.
 *   It is the middle of the night there  -> defer, do not drop.
 *   No approved template and the window
 *   has shut                             -> fail loudly and say why, rather
 *                                           than sending something Meta will
 *                                           refuse and nobody will notice.
 *
 * Per client, and one client's bad configuration never stops another's chases,
 * for the same reason the hold sweeper is built that way.
 */
export function createFollowUpWorker(container: Container): Worker<FollowUpSweeperJob> {
  return new Worker<FollowUpSweeperJob>(
    QUEUE_NAMES.followUpSweeper,
    async (job) => {
      const explicit = job.data.clientId;
      const clientIds = explicit ? [explicit] : await container.config.listActiveClientIds();
      const now = new Date();

      let sent = 0;
      for (const clientId of clientIds) {
        try {
          sent += await sweepOne(container, clientId, now);
        } catch (err) {
          container.log.error({ err, clientId }, "follow up sweep failed for one client, continuing with the rest");
        }
      }

      if (sent > 0) container.log.info({ sent, tenants: clientIds.length }, "follow ups sent");
    },
    {
      connection: queueRedis(),
      prefix: `${env().REDIS_KEY_PREFIX}:bull`,
      concurrency: 1,
    },
  );
}

async function sweepOne(container: Container, clientId: string, now: Date): Promise<number> {
  const due = await container.followUps.due(clientId, now);
  if (due.length === 0) return 0;

  const tenant = await container.config.loadProfile(clientId);
  let sent = 0;

  for (const item of due) {
    const log = container.log.child({ clientId, followUpId: item.id, kind: item.kind });

    const context = await container.db.withTenant(clientId, async (tx) => {
      const conversation = await tx.conversation.findUnique({
        where: { id: item.conversationId },
        select: { id: true, channel: true, aiEnabled: true, state: true, lastInboundAt: true, customerId: true },
      });
      if (!conversation) return null;

      const [customer, identity, quote] = await Promise.all([
        tx.customer.findUnique({ where: { id: conversation.customerId }, select: { fullName: true } }),
        tx.customerIdentity.findFirst({
          where: { clientId, customerId: conversation.customerId, channel: conversation.channel },
          select: { externalId: true },
        }),
        item.quoteId
          ? tx.quote.findUnique({
              where: { id: item.quoteId },
              select: { totalMinor: true, currency: true, vehicle: { select: { make: true, model: true } } },
            })
          : Promise.resolve(null),
      ]);

      return { conversation, customer, identity, quote };
    });

    if (!context?.identity) {
      await container.followUps.markFailed(clientId, item.id, "no reachable identity for this customer");
      continue;
    }

    // Somebody picked this up between scheduling and now.
    if (!context.conversation.aiEnabled || context.conversation.state === "HUMAN_TAKEOVER") {
      await container.db.withTenant(clientId, async (tx) => {
        await tx.followUp.update({
          where: { id: item.id },
          data: { status: "CANCELLED", cancelledReason: "a person is handling this conversation" },
        });
      });
      continue;
    }

    // Quiet hours are checked again at send time, not only at schedule time: a
    // chase scheduled for noon can sit in a backlog until midnight.
    const allowed = nextAllowedTime(now, tenant);
    if (allowed.getTime() > now.getTime()) {
      await container.followUps.defer(clientId, item.id, allowed);
      log.debug({ until: allowed }, "follow up deferred out of quiet hours");
      continue;
    }

    const composed = composeFollowUp(
      tenant,
      item.kind,
      context.conversation.channel,
      context.conversation.lastInboundAt,
      now,
      {
        customerName: firstNameOf(context.customer?.fullName),
        businessName: tenant.tradingName,
        vehicleName: context.quote ? `${context.quote.vehicle.make} ${context.quote.vehicle.model}` : "",
        quoteTotal: context.quote ? formatMoney(context.quote.totalMinor, context.quote.currency) : "",
      },
    );

    if (!composed) {
      // Almost always a missing or misnamed template. Worth failing loudly:
      // the silent version is a client whose conversion never improves and
      // nobody can say why.
      await container.followUps.markFailed(
        clientId,
        item.id,
        `no sendable wording for ${item.kind}: the service window has closed and no approved template is configured`,
      );
      log.warn("follow up has no approved template and the window has shut");
      continue;
    }

    const messageId = await container.db.withTenant(clientId, async (tx) => {
      const message = await tx.message.create({
        data: {
          clientId,
          conversationId: item.conversationId,
          direction: "OUTBOUND",
          channel: context.conversation.channel,
          body: composed.body,
          meta: { followUpId: item.id, kind: item.kind, attempt: item.attempt },
        },
        select: { id: true },
      });
      await container.audit.record(tx, clientId, {
        eventType: "FOLLOW_UP_SENT",
        actor: "AI",
        channel: context.conversation.channel,
        conversationId: item.conversationId,
        customerId: context.conversation.customerId,
        payload: { kind: item.kind, attempt: item.attempt, templated: Boolean(composed.template) },
      });
      return message.id;
    });

    await container.dispatcher.dispatch({
      clientId,
      conversationId: item.conversationId,
      messageId,
      channel: context.conversation.channel,
      to: context.identity.externalId,
      body: composed.body,
      ...(composed.template ? { template: composed.template } : {}),
      // A chase is exactly the case SMS exists for: the customer is not in a
      // live thread, so a text from an unfamiliar number is not jarring.
      allowSmsFallback: tenant.proactive.smsFallbackEnabled,
    });

    await container.followUps.markSent(clientId, item.id, composed.template?.name ?? null, messageId);
    sent += 1;

    // A second attempt, if the client's policy allows one.
    await container.followUps.schedule(tenant, {
      clientId,
      conversationId: item.conversationId,
      kind: item.kind,
      from: now,
      attempt: item.attempt + 1,
      ...(item.quoteId ? { quoteId: item.quoteId } : {}),
      ...(item.reservationId ? { reservationId: item.reservationId } : {}),
    });
  }

  return sent;
}

/**
 * "Rashid Al Maktoum" becomes "Rashid".
 *
 * A follow up that opens with somebody's full legal name reads like a debt
 * collection letter, which is the opposite of the tone a luxury rental desk
 * wants. Returns an empty string when the name is unknown, which makes the
 * template composer skip the send rather than greet a blank.
 */
function firstNameOf(fullName: string | null | undefined): string {
  if (!fullName) return "";
  return fullName.trim().split(/\s+/)[0] ?? "";
}

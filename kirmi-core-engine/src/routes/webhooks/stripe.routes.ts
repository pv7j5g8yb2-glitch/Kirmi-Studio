import { Router, type Request, type Response } from "express";
import type { Container } from "../../core/container.js";
import { asyncHandler } from "../../middleware/async-handler.js";
import { idempotencyGuard } from "../../middleware/idempotency.middleware.js";
import { verifyStripeWebhook } from "../../middleware/signature.middleware.js";
import { resolveTenant, slugFromPath } from "../../middleware/tenant-isolation.middleware.js";
import { WebhookService } from "../../services/webhook.service.js";

/**
 * ===========================================================================
 * STRIPE INBOUND: THE MOMENT A HOLD BECOMES A BOOKING
 * ===========================================================================
 *
 * The most commercially important endpoint in the engine, and the one that was
 * missing.
 *
 * Without it the chain broke in a way that cost real money and produced no
 * error at all. The agent quotes a customer at 11pm, they agree, a hold is
 * placed on the car, a payment link goes out. The hold sweeper releases it
 * thirty minutes later and marks the reservation EXPIRED. The attribution
 * report counts HOLD, CONFIRMED and COMPLETED, so that booking silently
 * vanished from the commission invoice. A booking the engine genuinely won,
 * that the customer genuinely paid for, billed as nothing.
 *
 * Two changes close it. Issuing a payment link extends the hold to
 * paymentHoldMinutes, and this route confirms the reservation the moment
 * Stripe says the money arrived.
 *
 * The tenant comes from the URL rather than the payload, because each client
 * connects their own Stripe account and therefore registers their own endpoint:
 *
 *   https://<host>/webhooks/stripe/<clientSlug>
 *
 * Middleware order is the security model, exactly as on the Meta route:
 * resolve the tenant, verify against THAT tenant's signing secret, reject
 * replays, then act. A forged event here would mark a car as paid for and put
 * a line on a client's invoice, so verification is not negotiable and there is
 * deliberately no unsigned escape hatch on this one.
 */
export function stripeWebhookRoutes(container: Container): Router {
  const router = Router();

  router.post(
    "/stripe/:clientSlug",
    resolveTenant(container.config, slugFromPath),
    verifyStripeWebhook(container.config),
    idempotencyGuard(container.idempotency, stripeEventId, "stripe"),
    asyncHandler(async (req: Request, res: Response) => {
      const clientId = req.routing?.clientId;
      if (!clientId) {
        res.sendStatus(404);
        return;
      }

      const body = req.body as StripeEvent;
      const eventId = stripeEventId(req) ?? WebhookService.fallbackEventId(req.rawBody ?? Buffer.alloc(0));

      await container.webhooks.record({
        clientId,
        provider: "stripe",
        externalEventId: eventId,
        eventType: body.type ?? "unknown",
        signatureValid: true,
        payload: body as unknown as Record<string, unknown>,
      });

      // Anything other than a completed checkout is acknowledged and ignored.
      // Stripe sends a great many event types and a 200 is how you stop it
      // retrying the ones you do not care about.
      if (body.type !== "checkout.session.completed") {
        res.json({ received: true });
        return;
      }

      const session = body.data?.object;
      const reservationId = session?.metadata?.reservationId;

      if (!reservationId) {
        req.log?.warn({ clientId, eventId }, "stripe checkout completed with no reservation id in metadata");
        res.json({ received: true });
        return;
      }

      // The tenant in the URL and the tenant in the metadata must agree.
      // Without this check, one client's Stripe account could confirm another
      // client's reservation, which is a tenant boundary crossing that row
      // level security cannot see because both writes are legitimate on their
      // own terms.
      if (session?.metadata?.clientId && session.metadata.clientId !== clientId) {
        req.log?.error(
          { clientId, claimed: session.metadata.clientId, eventId },
          "stripe event names a different client than the endpoint it arrived on, refusing",
        );
        res.status(409).json({ error: { code: "TENANT_MISMATCH" } });
        return;
      }

      const tenant = await container.config.loadProfile(clientId);

      // Read the conversation before confirming, so an escalation in the catch
      // below still knows which thread the customer is sitting in. Without it a
      // person is told a payment failed with no way to reach the customer.
      const existing = await container.db.withTenant(clientId, async (tx) =>
        tx.reservation.findUnique({ where: { id: reservationId }, select: { conversationId: true } }),
      );

      try {
        const reservation = await container.reservations.confirm(tenant, reservationId, {
          provider: "stripe",
          reference: session?.payment_intent ?? session?.id ?? eventId,
          paidMinor: session?.amount_total ?? 0,
        });

        // The customer has paid, so nothing should still be chasing them.
        if (reservation.conversationId) {
          await container.followUps
            .cancelFor(clientId, reservation.conversationId, "the customer paid")
            .catch(() => undefined);
        }

        req.log?.info(
          { clientId, reservationId, reference: reservation.reference },
          "payment confirmed, hold is now a booking",
        );
      } catch (err) {
        // The money has arrived and the booking could not be confirmed. That is
        // a person's problem, immediately: the customer believes they have a
        // car. Acknowledge to Stripe so it stops retrying, and escalate.
        req.log?.error({ err, clientId, reservationId }, "paid reservation could not be confirmed");

        // An escalation is scoped to a conversation, because that is where a
        // person has to go to speak to the customer. A paid reservation with no
        // conversation cannot be actioned that way, so it is logged loudly
        // instead of being forced into a queue nobody can act on.
        if (existing?.conversationId) {
          await container.escalations
            .escalate({
              tenant,
              conversationId: existing.conversationId,
              reason: "PAYMENT_DISPUTE",
              summary:
                `A customer has paid for booking ${reservationId} but it could not be confirmed. ` +
                `They believe they have the car. Check whether the hold expired, and confirm it by hand.`,
              context: { reservationId, eventId, amountMinor: session?.amount_total ?? 0 },
            })
            .catch(() => undefined);
        } else {
          req.log?.error(
            { clientId, reservationId, eventId, amountMinor: session?.amount_total ?? 0 },
            "PAID BUT UNCONFIRMED and no conversation to escalate to, needs a person now",
          );
        }
      }

      res.json({ received: true });
    }),
  );

  return router;
}

interface StripeEvent {
  id?: string;
  type?: string;
  data?: {
    object?: {
      id?: string;
      payment_intent?: string;
      amount_total?: number;
      metadata?: { reservationId?: string; clientId?: string };
    };
  };
}

/** Stripe's own event id, which is stable across its retries. */
function stripeEventId(req: Request): string | null {
  const body = req.body as StripeEvent | undefined;
  return body?.id ?? null;
}

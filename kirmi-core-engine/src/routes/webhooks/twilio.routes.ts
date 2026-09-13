import { Router, type Request, type Response } from "express";
import { QUEUE_NAMES } from "../../config/constants.js";
import type { Container } from "../../core/container.js";
import { asyncHandler } from "../../middleware/async-handler.js";
import { idempotencyGuard } from "../../middleware/idempotency.middleware.js";
import { verifyTwilioWebhook } from "../../middleware/signature.middleware.js";
import { resolveTenant, routingFromTwilioPayload } from "../../middleware/tenant-isolation.middleware.js";
import { enqueue } from "../../queue/queues.js";
import { WebhookService } from "../../services/webhook.service.js";

/**
 * ===========================================================================
 * TWILIO INBOUND: MISSED CALL TRIGGERS
 * ===========================================================================
 *
 * The highest intent signal a rental desk gets, and the one most often thrown
 * away. Somebody wanted this car enough to pick up the phone, nobody answered,
 * and that is usually where it ends.
 *
 * A missed call here becomes a WhatsApp message within seconds, while the
 * customer is still holding their phone and before they call the next company
 * on the list. Same tenant resolution, same signature verification, same
 * idempotency guard as Meta, because Twilio retries status callbacks too.
 */
export function twilioWebhookRoutes(container: Container): Router {
  const router = Router();

  router.post(
    "/twilio/voice",
    resolveTenant(container.config, routingFromTwilioPayload),
    verifyTwilioWebhook(container.config, container.webhooks),
    idempotencyGuard(container.idempotency, twilioEventId, "twilio"),
    asyncHandler(async (req: Request, res: Response) => {
      const clientId = req.routing?.clientId;
      if (!clientId) {
        res.sendStatus(404);
        return;
      }

      const body = req.body as Record<string, string>;
      const eventId = twilioEventId(req) ?? WebhookService.fallbackEventId(req.rawBody ?? Buffer.alloc(0));

      const { event, duplicate } = await container.webhooks.record({
        clientId,
        provider: "twilio",
        externalEventId: eventId,
        eventType: body["CallStatus"] ?? "voice",
        signatureValid: true,
        payload: body,
      });

      if (!duplicate && event) {
        await enqueue(
          QUEUE_NAMES.webhookIngest,
          { clientId, provider: "twilio", webhookEventId: event.id, receivedAtIso: new Date().toISOString() },
          { dedupeId: `twilio:${clientId}:${eventId}` },
        );
      }

      // Twilio expects TwiML. An empty response hangs up cleanly rather than
      // leaving the caller listening to silence.
      res.type("text/xml").status(200).send('<?xml version="1.0" encoding="UTF-8"?><Response/>');
    }),
  );

  return router;
}

/** CallSid plus status: one call produces several callbacks, each distinct. */
function twilioEventId(req: Request): string | null {
  const body = req.body as Record<string, string> | undefined;
  const sid = body?.["CallSid"] ?? body?.["MessageSid"];
  if (!sid) return null;
  const status = body?.["CallStatus"] ?? body?.["MessageStatus"] ?? "event";
  return `${sid}:${status}`;
}

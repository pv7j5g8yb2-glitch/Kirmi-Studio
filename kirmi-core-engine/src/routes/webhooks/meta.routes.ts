import { Router, type Request, type Response } from "express";
import { QUEUE_NAMES } from "../../config/constants.js";
import { env } from "../../config/env.js";
import type { Container } from "../../core/container.js";
import { safeEqual } from "../../core/crypto.js";
import { asyncHandler } from "../../middleware/async-handler.js";
import { idempotencyGuard } from "../../middleware/idempotency.middleware.js";
import { verifyMetaWebhook } from "../../middleware/signature.middleware.js";
import {
  resolveTenant,
  routingFromMetaPayload,
  slugFromPath,
  type MetaWebhookBody,
} from "../../middleware/tenant-isolation.middleware.js";
import { enqueue } from "../../queue/queues.js";
import { WebhookService } from "../../services/webhook.service.js";

/**
 * ===========================================================================
 * META INBOUND: WHATSAPP BUSINESS AND INSTAGRAM DM
 * ===========================================================================
 *
 * One endpoint, every tenant. The client is identified from the payload's own
 * phone_number_id or page id, so onboarding a new client is a configuration
 * row, not a new route and not a deploy.
 *
 * The middleware order below is the security model, and it only works in this
 * order:
 *
 *   1. resolveTenant     - who is this for, and open their isolation scope
 *   2. verifyMetaWebhook - is it genuinely from Meta, using THAT tenant's secret
 *   3. idempotencyGuard  - have we already seen this exact message
 *   4. handler           - persist, enqueue, 200
 *
 * Verification must come before idempotency: claiming keys from unverified
 * requests would let anyone suppress a tenant's real messages by pre-claiming
 * the ids. And both must come before any write, so an unauthenticated caller
 * cannot put a single row in a client's database.
 *
 * The handler does the minimum and returns. Meta retries anything it does not
 * get a fast 200 for, so the real work happens on the queue where a slow LLM
 * call costs latency instead of causing a duplicate delivery.
 */
export function metaWebhookRoutes(container: Container): Router {
  const router = Router();

  /**
   * Subscription verification. Meta calls this once when the webhook is
   * configured, with a challenge to echo back.
   */
  router.get(
    "/meta/:clientSlug",
    resolveTenant(container.config, slugFromPath),
    asyncHandler(async (req: Request, res: Response) => {
      const clientId = req.routing?.clientId;
      if (!clientId) {
        res.sendStatus(404);
        return;
      }

      const mode = req.query["hub.mode"];
      const token = req.query["hub.verify_token"];
      const challenge = req.query["hub.challenge"];

      const secrets = await container.config.loadSecrets(clientId);
      const expected = secrets.metaVerifyToken ?? env().META_WEBHOOK_VERIFY_TOKEN ?? null;

      if (mode === "subscribe" && expected && typeof token === "string" && safeEqual(token, expected)) {
        req.log?.info({ clientId }, "meta webhook subscription verified");
        res.status(200).send(String(challenge ?? ""));
        return;
      }

      req.log?.warn({ clientId }, "meta webhook verification rejected");
      res.sendStatus(403);
    }),
  );

  router.post(
    "/meta",
    resolveTenant(container.config, routingFromMetaPayload),
    verifyMetaWebhook(container.config, container.webhooks),
    idempotencyGuard(container.idempotency, metaEventId, "meta"),
    asyncHandler(async (req: Request, res: Response) => {
      const clientId = req.routing?.clientId;
      const body = req.body as MetaWebhookBody;
      if (!clientId) {
        res.sendStatus(404);
        return;
      }

      const eventId = metaEventId(req) ?? WebhookService.fallbackEventId(req.rawBody ?? Buffer.alloc(0));

      const { event, duplicate } = await container.webhooks.record({
        clientId,
        provider: "meta",
        externalEventId: eventId,
        eventType: body.entry?.[0]?.changes?.[0]?.field ?? "messages",
        signatureValid: true,
        payload: body,
      });

      // The durable half of the guard caught a replay Redis had forgotten.
      if (duplicate || !event) {
        res.status(200).json({ status: "duplicate" });
        return;
      }

      await enqueue(
        QUEUE_NAMES.webhookIngest,
        { clientId, provider: "meta", webhookEventId: event.id, receivedAtIso: new Date().toISOString() },
        // A third layer of deduplication: BullMQ rejects a live job with this id.
        { dedupeId: `meta:${clientId}:${eventId}` },
      );

      // Acknowledge immediately. Everything real happens on the queue.
      res.status(200).json({ status: "accepted" });
    }),
  );

  return router;
}

/**
 * The carrier's own message id, which is what makes deduplication reliable.
 * WhatsApp gives wamid..., Instagram gives mid.... Status callbacks reuse the
 * id of the message they describe, so they are keyed with a suffix to keep them
 * distinct from the message itself.
 */
function metaEventId(req: Request): string | null {
  const body = req.body as MetaWebhookBody | undefined;
  const entry = body?.entry?.[0];

  const message = entry?.changes?.[0]?.value?.messages?.[0]?.id;
  if (message) return message;

  const status = entry?.changes?.[0]?.value?.statuses?.[0];
  if (status?.id) return `${status.id}:${status.status ?? "status"}`;

  const instagram = entry?.messaging?.[0]?.message?.mid;
  if (instagram) return instagram;

  return null;
}

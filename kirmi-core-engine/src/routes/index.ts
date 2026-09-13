import { Router } from "express";
import type { Container } from "../core/container.js";
import { healthRoutes } from "./health.routes.js";
import { inboxRoutes } from "./inbox.routes.js";
import { metricsRoutes } from "./metrics.routes.js";
import { metaWebhookRoutes } from "./webhooks/meta.routes.js";
import { twilioWebhookRoutes } from "./webhooks/twilio.routes.js";

/**
 * The route table.
 *
 * Note there is no /clients/:id/anything. A client never appears in a path
 * because a caller never selects which tenant they are: it is derived from the
 * carrier payload or proved by an API key. A tenant id that a caller can choose
 * is a tenant id a caller can change.
 */
export function buildRoutes(container: Container): Router {
  const router = Router();

  router.use("/health", healthRoutes());
  router.use("/webhooks", metaWebhookRoutes(container));
  router.use("/webhooks", twilioWebhookRoutes(container));
  router.use("/api/metrics", metricsRoutes(container));
  router.use("/api/inbox", inboxRoutes(container));

  return router;
}

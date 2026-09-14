import type { WebhookEvent } from "@prisma/client";
import { sha256Hex } from "../core/crypto.js";
import type { TenantDatabase } from "../db/tenant-context.js";
import type { AuditService } from "./audit.service.js";

/**
 * Durable carrier history.
 *
 * The Redis interceptor catches almost every duplicate in under a millisecond.
 * This table is what still holds when Redis has been flushed, restarted or
 * failed over, and it is what an engineer reads at 2am when a client asks why a
 * particular enquiry never got a reply.
 *
 * Raw payloads are stored verbatim. A normalised copy is a copy of what we
 * thought the carrier sent, and the whole value of this table during an
 * incident is that it holds what they actually sent.
 */
export class WebhookService {
  constructor(
    private readonly db: TenantDatabase,
    private readonly audit: AuditService,
  ) {}

  /**
   * Persist an inbound delivery.
   *
   * Returns duplicate: true when the unique index rejects it, which is the
   * durable half of the idempotency guard. The caller treats that as success,
   * because it is: the event is recorded, we simply recorded it earlier.
   */
  async record(params: {
    clientId: string;
    provider: "meta" | "twilio" | "stripe";
    externalEventId: string;
    eventType?: string | null;
    signatureValid: boolean;
    payload: unknown;
  }): Promise<{ event: WebhookEvent | null; duplicate: boolean }> {
    return this.db.withTenant(params.clientId, async (tx) => {
      const existing = await tx.webhookEvent.findUnique({
        where: {
          clientId_provider_externalEventId: {
            clientId: params.clientId,
            provider: params.provider,
            externalEventId: params.externalEventId,
          },
        },
      });

      if (existing) {
        await this.audit.record(tx, params.clientId, {
          eventType: "WEBHOOK_DUPLICATE",
          actor: "WEBHOOK",
          payload: { provider: params.provider, externalEventId: params.externalEventId },
        });
        return { event: existing, duplicate: true };
      }

      const event = await tx.webhookEvent.create({
        data: {
          clientId: params.clientId,
          provider: params.provider,
          externalEventId: params.externalEventId,
          eventType: params.eventType ?? null,
          signatureValid: params.signatureValid,
          status: "QUEUED",
          payload: params.payload as object,
        },
      });

      await this.audit.record(tx, params.clientId, {
        eventType: "WEBHOOK_RECEIVED",
        actor: "WEBHOOK",
        payload: { provider: params.provider, externalEventId: params.externalEventId, eventType: params.eventType },
      });

      return { event, duplicate: false };
    });
  }

  async markProcessed(clientId: string, webhookEventId: string): Promise<void> {
    await this.db.withTenant(clientId, async (tx) => {
      await tx.webhookEvent.update({
        where: { id: webhookEventId },
        data: { status: "PROCESSED", processedAt: new Date() },
      });
    });
  }

  async markFailed(clientId: string, webhookEventId: string, error: string): Promise<void> {
    await this.db.withTenant(clientId, async (tx) => {
      await tx.webhookEvent.update({
        where: { id: webhookEventId },
        data: { status: "FAILED", error: error.slice(0, 2_000), attempts: { increment: 1 } },
      });
    });
  }

  async load(clientId: string, webhookEventId: string): Promise<WebhookEvent | null> {
    return this.db.withTenant(clientId, async (tx) => tx.webhookEvent.findUnique({ where: { id: webhookEventId } }));
  }

  /**
   * Record a rejected delivery.
   *
   * Only called once a clientId is known, which means a request whose signature
   * fails before routing is logged and dropped rather than written here. That
   * is intentional: an unauthenticated caller must not be able to fill a
   * tenant's table with rows of their choosing.
   */
  async recordRejection(clientId: string, provider: string, reason: string, bodyHash: string): Promise<void> {
    await this.db.withTenant(clientId, async (tx) => {
      await this.audit.record(tx, clientId, {
        eventType: "WEBHOOK_REJECTED",
        actor: "WEBHOOK",
        payload: { provider, reason, bodyHash },
      });
    });
  }

  /** Stable key for a payload that carries no id of its own. */
  static fallbackEventId(rawBody: Buffer): string {
    return `sha256:${sha256Hex(rawBody)}`;
  }
}

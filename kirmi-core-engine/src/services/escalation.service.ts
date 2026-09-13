import type { Escalation, EscalationReason } from "@prisma/client";
import type { Logger } from "../core/logger.js";
import type { TenantProfile } from "../core/types.js";
import type { TenantDatabase } from "../db/tenant-context.js";
import type { AuditService } from "./audit.service.js";

/**
 * ===========================================================================
 * THE HUMAN CONCIERGE HANDOFF
 * ===========================================================================
 *
 * When the engine stops talking and a person starts.
 *
 * Three things happen, in this order, and the order is the design:
 *
 *   1. aiEnabled flips to false and the conversation moves to HUMAN_TAKEOVER,
 *      inside a transaction. The agent is silenced first, before anyone is
 *      told, because the failure mode to avoid is a notification landing on a
 *      salesperson's phone while the agent is still cheerfully quoting an
 *      under age driver in the same thread.
 *   2. The escalation is persisted. A notification that is only a WebSocket
 *      frame is lost if nobody has the dashboard open, and an escalation nobody
 *      sees is the worst outcome in this whole system: a real customer, stuck,
 *      with an agent that has gone silent on purpose.
 *   3. Only then is it broadcast.
 *
 * Escalation is a feature, not a failure. A 24 year old asking for a Urus, or a
 * customer asking for a weekly rate that is not published, is exactly the
 * conversation a human should be having. The engine's job is to hand it over
 * fast, with the context already gathered.
 */

export interface EscalationBroadcaster {
  /** Push to the human inbox. Fire and forget: never blocks the takeover. */
  publish(clientId: string, event: EscalationEvent): void;
}

export interface EscalationEvent {
  type: "escalation.opened";
  escalationId: string;
  clientId: string;
  conversationId: string;
  reason: EscalationReason;
  summary: string;
  context: Record<string, unknown>;
  openedAt: string;
}

export interface EscalateParams {
  tenant: TenantProfile;
  conversationId: string;
  reason: EscalationReason;
  summary: string;
  context?: Record<string, unknown>;
  customerId?: string | null;
}

export class EscalationService {
  constructor(
    private readonly db: TenantDatabase,
    private readonly audit: AuditService,
    private readonly broadcaster: EscalationBroadcaster,
    private readonly log: Logger,
  ) {}

  async escalate(params: EscalateParams): Promise<Escalation> {
    const { tenant, conversationId, reason, summary } = params;
    const context = params.context ?? {};

    const escalation = await this.db.withTenant(tenant.clientId, async (tx) => {
      // 1. Silence the agent. First, and in the same transaction as everything
      //    else, so there is no window where the escalation exists but the
      //    agent is still answering.
      await tx.conversation.update({
        where: { id: conversationId },
        data: {
          aiEnabled: false,
          state: "HUMAN_TAKEOVER",
          takeoverReason: reason,
          takeoverAt: new Date(),
        },
      });

      // 2. Persist, so the handover survives a dashboard nobody has open.
      const created = await tx.escalation.create({
        data: {
          clientId: tenant.clientId,
          conversationId,
          reason,
          summary,
          context: context as object,
          status: "OPEN",
        },
      });

      await this.audit.record(tx, tenant.clientId, {
        eventType: "HUMAN_ESCALATION",
        actor: "SYSTEM",
        conversationId,
        customerId: params.customerId ?? null,
        payload: { reason, summary, escalationId: created.id },
      });

      await this.audit.record(tx, tenant.clientId, {
        eventType: "AI_DISABLED",
        actor: "SYSTEM",
        conversationId,
        payload: { reason },
      });

      return created;
    });

    // 3. Broadcast, outside the transaction. A slow or dead socket must not
    //    roll back a takeover that has already been committed.
    this.broadcaster.publish(tenant.clientId, {
      type: "escalation.opened",
      escalationId: escalation.id,
      clientId: tenant.clientId,
      conversationId,
      reason,
      summary,
      context,
      openedAt: escalation.createdAt.toISOString(),
    });

    this.log.warn({ clientId: tenant.clientId, conversationId, reason }, "conversation escalated to a human");

    await this.db.withTenant(tenant.clientId, async (tx) => {
      await tx.escalation.update({ where: { id: escalation.id }, data: { notifiedAt: new Date() } });
    });

    return escalation;
  }

  async acknowledge(clientId: string, escalationId: string, by: string): Promise<Escalation> {
    return this.db.withTenant(clientId, async (tx) =>
      tx.escalation.update({
        where: { id: escalationId },
        data: { status: "ACKNOWLEDGED", acknowledgedAt: new Date(), acknowledgedBy: by },
      }),
    );
  }

  /**
   * Close an escalation and optionally hand the thread back to the agent.
   *
   * Handing back is opt in. A human who has just rescued a conversation should
   * decide whether the agent resumes, rather than the agent deciding for itself
   * that the problem looks solved.
   */
  async resolve(clientId: string, escalationId: string, options: { reenableAi: boolean }): Promise<Escalation> {
    return this.db.withTenant(clientId, async (tx) => {
      const escalation = await tx.escalation.update({
        where: { id: escalationId },
        data: { status: "RESOLVED", resolvedAt: new Date() },
      });

      if (options.reenableAi) {
        await tx.conversation.update({
          where: { id: escalation.conversationId },
          data: { aiEnabled: true, state: "QUALIFIED", takeoverReason: null, takeoverAt: null },
        });
        await this.audit.record(tx, clientId, {
          eventType: "AI_ENABLED",
          actor: "HUMAN",
          conversationId: escalation.conversationId,
          payload: { escalationId },
        });
      }

      return escalation;
    });
  }

  async listOpen(clientId: string, limit = 50): Promise<Escalation[]> {
    return this.db.withTenant(clientId, async (tx) =>
      tx.escalation.findMany({
        where: { status: { in: ["OPEN", "ACKNOWLEDGED"] } },
        orderBy: { createdAt: "desc" },
        take: limit,
      }),
    );
  }
}

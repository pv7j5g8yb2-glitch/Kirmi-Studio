import type { ChannelType } from "@prisma/client";
import { env } from "../config/env.js";
import type { ContextCache } from "../cache/conversation-context.cache.js";
import { AiDisabledError } from "../core/errors.js";
import type { Logger } from "../core/logger.js";
import { elapsedMs, startTimer } from "../core/time.js";
import type { TenantProfile } from "../core/types.js";
import type { TenantDatabase } from "../db/tenant-context.js";
import type { AuditService } from "../services/audit.service.js";
import type { ConversationService } from "../services/conversation.service.js";
import type { CustomerService } from "../services/customer.service.js";
import type { EscalationService } from "../services/escalation.service.js";
import { buildSystemPrompt, type LlmClient, type LlmTurn } from "./llm.client.js";
import { AGENT_TOOLS } from "./tools.schema.js";
import type { ToolExecutor } from "./tool-executor.js";

/**
 * ===========================================================================
 * THE REPLY PIPELINE
 * ===========================================================================
 *
 * One inbound message in, one outbound reply out, inside the latency budget.
 *
 *   1. Resolve the customer from their channel handle.
 *   2. Open or find the live conversation.
 *   3. Check aiEnabled. If a human has taken over, stop. Silently, and
 *      immediately.
 *   4. Load context (cached) and ask the model what it wants.
 *   5. Execute any tool calls against the real database with real locks.
 *   6. Ask the model to phrase the result, then send it.
 *   7. Record latency against the SLA, and raise a breach event if it was missed.
 *
 * Step 3 appears twice: once here, and again inside the transaction that writes
 * the reply. The second check is the one that counts. Between asking the model
 * and writing its answer there are seconds of wall clock time, which is ample
 * for a human to hit take over, and the agent must not get one last word in
 * after that.
 *
 * The SLA is measured from carrier receipt, not from when this function
 * started. A message that sat in the queue for eleven seconds and was answered
 * in two took thirteen seconds from the customer's point of view, and that is
 * the number the client was promised.
 */

export interface InboundMessage {
  channel: ChannelType;
  externalId: string;
  displayName?: string;
  providerMessageId: string;
  body: string;
  receivedAt: Date;
}

/**
 * How a composed reply leaves the building.
 *
 * A port rather than a direct call to the queue, for the same reason everything
 * else here is: the SLA tests run the whole pipeline with a dispatcher that
 * records instead of sending, so they measure the engine without touching Meta.
 */
export interface OutboundDispatcher {
  dispatch(job: {
    clientId: string;
    conversationId: string;
    messageId: string;
    channel: ChannelType;
    to: string;
    body: string;
  }): Promise<void>;
}

export interface PipelineResult {
  status: "replied" | "suppressed" | "escalated" | "empty";
  conversationId?: string;
  reply?: string;
  latencyMs: number;
  slaBreached: boolean;
}

export class MessagePipeline {
  constructor(
    private readonly db: TenantDatabase,
    private readonly customers: CustomerService,
    private readonly conversations: ConversationService,
    private readonly escalations: EscalationService,
    private readonly tools: ToolExecutor,
    private readonly llm: LlmClient,
    private readonly cache: ContextCache,
    private readonly audit: AuditService,
    private readonly dispatcher: OutboundDispatcher,
    private readonly log: Logger,
  ) {}

  async handle(tenant: TenantProfile, inbound: InboundMessage): Promise<PipelineResult> {
    const timer = startTimer();
    const config = env();

    // Latency the customer actually experienced, including queue time.
    const sinceReceipt = (): number => Date.now() - inbound.receivedAt.getTime();

    // --- 1 and 2. Identity and thread, in one transaction ------------------
    const { conversationId, customerId, isNewConversation } = await this.db.withTenant(
      tenant.clientId,
      async (tx) => {
        const { customer } = await this.customers.resolveByIdentity(
          tx,
          tenant.clientId,
          inbound.channel,
          inbound.externalId,
          inbound.displayName,
        );
        const { conversation, isNew } = await this.conversations.ensureOpen(
          tx,
          tenant.clientId,
          customer.id,
          inbound.channel,
        );

        await this.conversations.recordMessage(tx, tenant.clientId, {
          conversationId: conversation.id,
          direction: "INBOUND",
          channel: inbound.channel,
          body: inbound.body,
          providerMessageId: inbound.providerMessageId,
        });

        // Counted once per conversation, not per message. A customer who sends
        // four messages in a row is one enquiry, and counting it as four would
        // flatter the conversion rate into meaninglessness.
        if (isNew) {
          await this.audit.record(tx, tenant.clientId, {
            eventType: "ENQUIRY_RECEIVED",
            actor: "WEBHOOK",
            channel: inbound.channel,
            conversationId: conversation.id,
            customerId: customer.id,
            payload: { firstMessage: inbound.body.slice(0, 500) },
          });
        }

        return { conversationId: conversation.id, customerId: customer.id, isNewConversation: isNew };
      },
    );

    // --- 3. Stand down if a human has the thread ---------------------------
    const conversation = await this.db.withTenant(tenant.clientId, async (tx) =>
      this.conversations.get(tx, conversationId),
    );
    if (!conversation.aiEnabled || conversation.state === "HUMAN_TAKEOVER") {
      this.log.info({ conversationId }, "conversation is in human hands, agent standing down");
      return { status: "suppressed", conversationId, latencyMs: sinceReceipt(), slaBreached: false };
    }

    // --- 4. Context and the first model turn -------------------------------
    const turns = await this.buildTurns(tenant, conversationId, inbound);
    const system = buildSystemPrompt(tenant, new Date());

    let response = await this.llm.complete({ system, turns, tools: AGENT_TOOLS });

    // --- 5. Tool execution -------------------------------------------------
    let pendingEscalation: { reason: "AGE_BELOW_MINIMUM" | "CUSTOM_RATE_REQUEST" | "INVENTORY_CONFLICT"; summary: string } | null = null;

    if (response.toolCalls.length > 0) {
      const results: Array<{ toolCallId: string; content: string; isError?: boolean }> = [];

      for (const call of response.toolCalls) {
        const outcome = await this.tools.execute(call.name, call.input, {
          tenant,
          conversationId,
          customerId,
        });
        results.push({ toolCallId: call.id, content: outcome.content, ...(outcome.isError ? { isError: true } : {}) });
        if (outcome.escalation) pendingEscalation = outcome.escalation;
      }

      // A failed qualification stops the conversation here. The model is not
      // asked to phrase a refusal, because the right outcome is a person, not
      // a well worded no.
      if (pendingEscalation) {
        await this.escalations.escalate({
          tenant,
          conversationId,
          reason: pendingEscalation.reason,
          summary: pendingEscalation.summary,
          customerId,
          context: { lastMessage: inbound.body, channel: inbound.channel },
        });
        return { status: "escalated", conversationId, latencyMs: sinceReceipt(), slaBreached: false };
      }

      response = await this.llm.complete({ system, turns, tools: AGENT_TOOLS, toolResults: results });
    }

    const reply = response.text?.trim();
    if (!reply) {
      // The model produced nothing usable. Escalating beats sending silence: a
      // customer waiting on a reply that never comes is the failure this whole
      // product exists to remove.
      this.log.warn({ conversationId, stopReason: response.stopReason }, "model produced no reply, escalating");
      await this.escalations.escalate({
        tenant,
        conversationId,
        reason: "LOW_CONFIDENCE",
        summary: "The agent could not produce a reply",
        customerId,
        context: { lastMessage: inbound.body, stopReason: response.stopReason },
      });
      return { status: "escalated", conversationId, latencyMs: sinceReceipt(), slaBreached: false };
    }

    // --- 6. Write the reply, re-checking the kill switch under the same tx ---
    const latencyMs = sinceReceipt();
    const slaBreached = latencyMs > config.REPLY_SLA_MS;

    let outboundMessageId: string | null = null;

    try {
      await this.db.withTenant(tenant.clientId, async (tx) => {
        // The check that counts. Seconds have passed since the first one.
        await this.conversations.assertAiEnabled(tx, conversationId);

        const written = await this.conversations.recordMessage(tx, tenant.clientId, {
          conversationId,
          direction: "OUTBOUND",
          channel: inbound.channel,
          body: reply,
          latencyMs,
          slaBreached,
        });
        outboundMessageId = written.id;

        if (isNewConversation) {
          await this.conversations.setState(tx, conversationId, "QUALIFIED");
        }

        await this.audit.record(tx, tenant.clientId, {
          eventType: "MESSAGE_SENT",
          actor: "AI",
          channel: inbound.channel,
          conversationId,
          customerId,
          payload: { latencyMs, slaBreached },
        });

        if (slaBreached) {
          // Recorded as its own event so a client can audit the promise they
          // were sold, rather than being told it is fine.
          await this.audit.record(tx, tenant.clientId, {
            eventType: "SLA_BREACH",
            conversationId,
            payload: { latencyMs, budgetMs: config.REPLY_SLA_MS },
          });
        }
      });
    } catch (err) {
      if (err instanceof AiDisabledError) {
        this.log.info({ conversationId }, "human took over mid-flight, reply discarded");
        return { status: "suppressed", conversationId, latencyMs, slaBreached: false };
      }
      throw err;
    }

    // Recorded first, sent second. If this ordering were reversed, a crash
    // between the two would leave a customer holding a message the system has
    // no memory of, and the next reply would repeat it or contradict it.
    if (outboundMessageId) {
      await this.dispatcher.dispatch({
        clientId: tenant.clientId,
        conversationId,
        messageId: outboundMessageId,
        channel: inbound.channel,
        to: inbound.externalId,
        body: reply,
      });
    }

    await this.refreshCache(tenant, conversationId, customerId, inbound, reply);

    if (slaBreached) {
      this.log.warn({ conversationId, latencyMs, budgetMs: config.REPLY_SLA_MS }, "reply SLA breached");
    } else if (latencyMs > config.REPLY_TARGET_MS) {
      this.log.info({ conversationId, latencyMs }, "reply slower than target but within SLA");
    }

    this.log.debug({ conversationId, elapsedMs: elapsedMs(timer) }, "pipeline complete");
    return { status: "replied", conversationId, reply, latencyMs, slaBreached };
  }

  /**
   * Conversation history for the model. Cache first: on the warm path this is
   * one Redis GET instead of a query, which is most of the difference between
   * a three second reply and an eight second one.
   */
  private async buildTurns(tenant: TenantProfile, conversationId: string, inbound: InboundMessage): Promise<LlmTurn[]> {
    const cached = await this.cache.getContext(tenant.clientId, conversationId);

    if (cached) {
      return [
        ...cached.recentTurns.map((t) => ({
          role: t.role === "customer" ? ("user" as const) : ("assistant" as const),
          content: t.text,
        })),
        { role: "user", content: inbound.body },
      ];
    }

    const history = await this.db.withTenant(tenant.clientId, async (tx) =>
      this.conversations.recentTurns(tx, conversationId, 12),
    );

    return history.map((m) => ({
      role: m.direction === "INBOUND" ? ("user" as const) : ("assistant" as const),
      content: m.body,
    }));
  }

  private async refreshCache(
    tenant: TenantProfile,
    conversationId: string,
    customerId: string,
    inbound: InboundMessage,
    reply: string,
  ): Promise<void> {
    const existing = await this.cache.getContext(tenant.clientId, conversationId);
    const turns = [
      ...(existing?.recentTurns ?? []),
      { role: "customer" as const, text: inbound.body, at: inbound.receivedAt.toISOString() },
      { role: "agent" as const, text: reply, at: new Date().toISOString() },
    ].slice(-12);

    await this.cache.putContext(tenant.clientId, {
      conversationId,
      customerId,
      channel: inbound.channel,
      state: "QUALIFIED",
      aiEnabled: true,
      language: existing?.language ?? null,
      recentTurns: turns,
      slots: existing?.slots ?? {},
      updatedAt: new Date().toISOString(),
    });
  }
}

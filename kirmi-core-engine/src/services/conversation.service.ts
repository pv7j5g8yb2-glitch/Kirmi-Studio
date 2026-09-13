import type { ChannelType, Conversation, ConversationState, Message, MessageDirection } from "@prisma/client";
import { AiDisabledError, NotFoundError } from "../core/errors.js";
import type { TenantTx } from "../db/tenant-context.js";

/**
 * Conversation and message state.
 *
 * The one rule worth stating loudly: aiEnabled is checked immediately before an
 * automated reply is written, inside the same transaction, never earlier. A
 * check performed at the top of a pipeline that then spends four seconds in an
 * LLM call is a check against a state that may have changed. A human clicking
 * "take over" in the inbox must silence the agent mid flight, not after its
 * current reply has already gone out.
 */
export class ConversationService {
  /**
   * The live thread for a customer on a channel, opened on first contact.
   *
   * A partial unique index enforces one open conversation per customer per
   * channel, so a burst of simultaneous messages cannot fork the thread.
   */
  async ensureOpen(
    tx: TenantTx,
    clientId: string,
    customerId: string,
    channel: ChannelType,
    externalThreadId?: string,
  ): Promise<{ conversation: Conversation; isNew: boolean }> {
    const existing = await tx.conversation.findFirst({
      where: { customerId, channel, closedAt: null },
      orderBy: { createdAt: "desc" },
    });
    if (existing) return { conversation: existing, isNew: false };

    const conversation = await tx.conversation.create({
      data: {
        clientId,
        customerId,
        channel,
        state: "NEW_ENQUIRY",
        externalThreadId: externalThreadId ?? null,
      },
    });
    return { conversation, isNew: true };
  }

  async get(tx: TenantTx, conversationId: string): Promise<Conversation> {
    const conversation = await tx.conversation.findUnique({ where: { id: conversationId } });
    if (!conversation) throw new NotFoundError("Conversation not found", { conversationId });
    return conversation;
  }

  /**
   * Read the conversation and refuse if the AI has been switched off.
   *
   * Called inside the writing transaction. That placement is the whole
   * guarantee: the row is read in the same transaction that writes the reply,
   * so a concurrent takeover either lands before this read, and we stand down,
   * or after our commit, and the human sees our last message in the thread.
   */
  async assertAiEnabled(tx: TenantTx, conversationId: string): Promise<Conversation> {
    const conversation = await this.get(tx, conversationId);
    if (!conversation.aiEnabled || conversation.state === "HUMAN_TAKEOVER") {
      throw new AiDisabledError("Conversation is in human hands", {
        conversationId,
        state: conversation.state,
      });
    }
    return conversation;
  }

  async setState(tx: TenantTx, conversationId: string, state: ConversationState): Promise<Conversation> {
    return tx.conversation.update({
      where: { id: conversationId },
      data: { state, ...(state === "CLOSED" ? { closedAt: new Date() } : {}) },
    });
  }

  /** Hand the thread back to the agent, after a human has finished with it. */
  async reenableAi(tx: TenantTx, conversationId: string, state: ConversationState = "QUALIFIED"): Promise<Conversation> {
    return tx.conversation.update({
      where: { id: conversationId },
      data: { aiEnabled: true, state, takeoverReason: null, takeoverAt: null },
    });
  }

  async recordMessage(
    tx: TenantTx,
    clientId: string,
    params: {
      conversationId: string;
      direction: MessageDirection;
      channel: ChannelType;
      body: string;
      providerMessageId?: string | null;
      mediaUrls?: string[];
      latencyMs?: number | null;
      slaBreached?: boolean;
      meta?: Record<string, unknown>;
    },
  ): Promise<Message> {
    const message = await tx.message.create({
      data: {
        clientId,
        conversationId: params.conversationId,
        direction: params.direction,
        channel: params.channel,
        body: params.body,
        providerMessageId: params.providerMessageId ?? null,
        mediaUrls: params.mediaUrls ?? [],
        latencyMs: params.latencyMs ?? null,
        slaBreached: params.slaBreached ?? false,
        meta: (params.meta ?? {}) as object,
      },
    });

    await tx.conversation.update({
      where: { id: params.conversationId },
      data:
        params.direction === "INBOUND"
          ? { lastInboundAt: message.createdAt }
          : { lastOutboundAt: message.createdAt },
    });

    return message;
  }

  /** The last few turns, oldest first, for rebuilding context on a cache miss. */
  async recentTurns(tx: TenantTx, conversationId: string, limit = 12): Promise<Message[]> {
    const rows = await tx.message.findMany({
      where: { conversationId },
      orderBy: { createdAt: "desc" },
      take: limit,
    });
    return rows.reverse();
  }
}

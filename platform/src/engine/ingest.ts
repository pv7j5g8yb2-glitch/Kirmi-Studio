import type { Queryable } from "../db/index.js";
import type { NormalisedInbound } from "../channels/types.js";
import { upsertCustomer, openConversation, recordMessage, getConversation, takeOver } from "../domain/conversations.js";
import { queueReply } from "../domain/outbox.js";
import { handleInbound } from "./orchestrator.js";
import { audit } from "../core/audit.js";

export type IngestResult = {
  duplicate: boolean;
  conversationId: string;
  inboundMessageId: string;
  replyQueued: boolean;
  escalated: boolean;
  enquiryId: string | null;
  quoteId: string | null;
  reply: string | null;
};

/**
 * One inbound message, end to end: identify → persist → think → queue reply.
 *
 * Idempotent on the provider's message id. A Meta retry (they resend until they get a
 * 200) reaches here again and exits at the duplicate check, so the customer never gets
 * the same answer twice.
 */
export async function ingestInbound(
  db: Queryable,
  tenantId: string,
  msg: NormalisedInbound,
  opts: { companyName: string; now?: Date },
): Promise<IngestResult> {
  const now = opts.now ?? new Date();

  const customer = await upsertCustomer(db, tenantId, {
    phoneE164: msg.channel === "whatsapp" ? msg.from : null,
    instagramId: msg.channel === "instagram" ? msg.from : null,
    displayName: msg.displayName,
  });

  const conversation = await openConversation(db, tenantId, customer.id, msg.channel);

  const inbound = await recordMessage(db, tenantId, {
    conversationId: conversation.id,
    direction: "inbound",
    channel: msg.channel,
    body: msg.text,
    author: "customer",
    providerMessageId: msg.providerMessageId,
    status: "received",
    payload: msg.raw,
  });

  if (!inbound.created) {
    return {
      duplicate: true, conversationId: conversation.id, inboundMessageId: inbound.id,
      replyQueued: false, escalated: false, enquiryId: null, quoteId: null, reply: null,
    };
  }

  // Non-text (image, location, sticker) gets a person rather than a guess.
  if (!msg.text || !msg.text.trim()) {
    await audit({ tenantId, actor: "system", action: "conversation.escalated", entity: "conversation", entityId: conversation.id, data: { reason: "non-text message" } }, db);
    return {
      duplicate: false, conversationId: conversation.id, inboundMessageId: inbound.id,
      replyQueued: false, escalated: true, enquiryId: null, quoteId: null, reply: null,
    };
  }

  const current = await getConversation(db, tenantId, conversation.id);
  const decision = await handleInbound(
    { db, tenantId, conversation: current ?? conversation, now },
    msg.text,
    opts.companyName,
  );

  let replyQueued = false;
  if (decision.reply) {
    await queueReply(db, tenantId, {
      conversationId: conversation.id,
      channel: msg.channel,
      to: msg.from,
      body: decision.reply,
      author: "ai",
      // Tie the reply to the inbound message so a replay cannot double-send.
      idempotencyKey: `reply:${msg.providerMessageId}`,
    });
    replyQueued = true;
  }

  if (decision.escalate) {
    await db.query(`UPDATE conversations SET state='human_active' WHERE tenant_id=$1 AND id=$2 AND state='ai_active'`, [
      tenantId, conversation.id,
    ]);
    await audit(
      { tenantId, actor: "ai", action: "conversation.escalated", entity: "conversation", entityId: conversation.id, data: { reason: decision.escalate.reason } },
      db,
    );
  }

  return {
    duplicate: false,
    conversationId: conversation.id,
    inboundMessageId: inbound.id,
    replyQueued,
    escalated: Boolean(decision.escalate),
    enquiryId: decision.enquiryId,
    quoteId: decision.quoteId,
    reply: decision.reply,
  };
}

export { takeOver };

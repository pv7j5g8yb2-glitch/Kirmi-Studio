import type { Queryable } from "../db/index.js";
import { audit } from "../core/audit.js";

export type ChannelName = "whatsapp" | "instagram" | "voice" | "web";
export type ConversationState = "ai_active" | "human_active" | "closed";

export type Conversation = {
  id: string;
  customerId: string;
  channel: ChannelName;
  state: ConversationState;
  assignedUserId: string | null;
  lastInboundAt: string | null;
  lastMessageAt: string | null;
  locale: string | null;
};

export type Customer = {
  id: string;
  displayName: string | null;
  phoneE164: string | null;
  instagramId: string | null;
  locale: string | null;
};

/** WhatsApp only allows free-form replies within 24h of the customer's last message. */
export const SERVICE_WINDOW_MS = 24 * 60 * 60 * 1000;

export function withinServiceWindow(lastInboundAt: string | Date | null, now = new Date()): boolean {
  if (!lastInboundAt) return false;
  const t = typeof lastInboundAt === "string" ? new Date(lastInboundAt) : lastInboundAt;
  return now.getTime() - t.getTime() < SERVICE_WINDOW_MS;
}

export async function upsertCustomer(
  db: Queryable,
  tenantId: string,
  input: { phoneE164?: string | null; instagramId?: string | null; displayName?: string | null; locale?: string | null },
): Promise<Customer> {
  if (!input.phoneE164 && !input.instagramId) throw new Error("upsertCustomer: need a phone or instagram id");
  const col = input.phoneE164 ? "phone_e164" : "instagram_id";
  const { rows } = await db.query(
    `INSERT INTO customers (tenant_id, phone_e164, instagram_id, display_name, locale)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (tenant_id, ${col}) DO UPDATE
       SET display_name = COALESCE(EXCLUDED.display_name, customers.display_name),
           locale = COALESCE(EXCLUDED.locale, customers.locale)
     RETURNING id, display_name, phone_e164, instagram_id, locale`,
    [tenantId, input.phoneE164 ?? null, input.instagramId ?? null, input.displayName ?? null, input.locale ?? null],
  );
  const r = rows[0];
  return { id: r.id, displayName: r.display_name, phoneE164: r.phone_e164, instagramId: r.instagram_id, locale: r.locale };
}

export async function openConversation(
  db: Queryable,
  tenantId: string,
  customerId: string,
  channel: ChannelName,
  locale?: string | null,
): Promise<Conversation> {
  const { rows: existing } = await db.query(
    `SELECT id, customer_id, channel, state, assigned_user_id, last_inbound_at, last_message_at, locale
       FROM conversations
      WHERE tenant_id=$1 AND customer_id=$2 AND channel=$3 AND state <> 'closed'
      ORDER BY created_at DESC LIMIT 1`,
    [tenantId, customerId, channel],
  );
  if (existing[0]) return mapConversation(existing[0]);
  const { rows } = await db.query(
    `INSERT INTO conversations (tenant_id, customer_id, channel, locale)
     VALUES ($1,$2,$3,$4)
     RETURNING id, customer_id, channel, state, assigned_user_id, last_inbound_at, last_message_at, locale`,
    [tenantId, customerId, channel, locale ?? null],
  );
  return mapConversation(rows[0]);
}

function mapConversation(r: any): Conversation {
  return {
    id: r.id,
    customerId: r.customer_id,
    channel: r.channel,
    state: r.state,
    assignedUserId: r.assigned_user_id,
    lastInboundAt: r.last_inbound_at ? new Date(r.last_inbound_at).toISOString() : null,
    lastMessageAt: r.last_message_at ? new Date(r.last_message_at).toISOString() : null,
    locale: r.locale,
  };
}

export async function getConversation(db: Queryable, tenantId: string, id: string): Promise<Conversation | null> {
  const { rows } = await db.query(
    `SELECT id, customer_id, channel, state, assigned_user_id, last_inbound_at, last_message_at, locale
       FROM conversations WHERE tenant_id=$1 AND id=$2`,
    [tenantId, id],
  );
  return rows[0] ? mapConversation(rows[0]) : null;
}

export type RecordMessageInput = {
  conversationId: string;
  direction: "inbound" | "outbound";
  channel: ChannelName;
  body: string | null;
  author: "customer" | "ai" | "operator" | "system";
  authorUserId?: string | null;
  providerMessageId?: string | null;
  status?: "received" | "queued" | "sent" | "delivered" | "read" | "failed";
  payload?: Record<string, unknown>;
};

/**
 * Inserts a message, deduplicating on provider_message_id. A webhook replay returns
 * the original row and `created:false` rather than a second copy of the customer's text.
 */
export async function recordMessage(
  db: Queryable,
  tenantId: string,
  input: RecordMessageInput,
): Promise<{ id: string; created: boolean }> {
  if (input.providerMessageId) {
    const { rows } = await db.query(
      `INSERT INTO messages (tenant_id, conversation_id, direction, channel, body, payload,
                             provider_message_id, status, author, author_user_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (tenant_id, channel, provider_message_id) WHERE provider_message_id IS NOT NULL
       DO NOTHING
       RETURNING id`,
      [
        tenantId, input.conversationId, input.direction, input.channel, input.body,
        JSON.stringify(input.payload ?? {}), input.providerMessageId,
        input.status ?? (input.direction === "inbound" ? "received" : "queued"),
        input.author, input.authorUserId ?? null,
      ],
    );
    if (rows[0]) {
      await touchConversation(db, tenantId, input);
      return { id: rows[0].id, created: true };
    }
    const { rows: dup } = await db.query(
      `SELECT id FROM messages WHERE tenant_id=$1 AND channel=$2 AND provider_message_id=$3`,
      [tenantId, input.channel, input.providerMessageId],
    );
    return { id: dup[0].id, created: false };
  }

  const { rows } = await db.query(
    `INSERT INTO messages (tenant_id, conversation_id, direction, channel, body, payload, status, author, author_user_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
    [
      tenantId, input.conversationId, input.direction, input.channel, input.body,
      JSON.stringify(input.payload ?? {}),
      input.status ?? (input.direction === "inbound" ? "received" : "queued"),
      input.author, input.authorUserId ?? null,
    ],
  );
  await touchConversation(db, tenantId, input);
  return { id: rows[0].id, created: true };
}

async function touchConversation(db: Queryable, tenantId: string, input: RecordMessageInput): Promise<void> {
  if (input.direction === "inbound") {
    await db.query(
      `UPDATE conversations SET last_inbound_at = now(), last_message_at = now() WHERE tenant_id=$1 AND id=$2`,
      [tenantId, input.conversationId],
    );
  } else {
    await db.query(`UPDATE conversations SET last_message_at = now() WHERE tenant_id=$1 AND id=$2`, [
      tenantId,
      input.conversationId,
    ]);
  }
}

export async function listMessages(db: Queryable, tenantId: string, conversationId: string, limit = 50) {
  const { rows } = await db.query(
    `SELECT id, direction, channel, body, author, status, created_at, provider_message_id
       FROM messages WHERE tenant_id=$1 AND conversation_id=$2
      ORDER BY created_at ASC LIMIT $3`,
    [tenantId, conversationId, limit],
  );
  return rows.map((r: any) => ({
    id: r.id, direction: r.direction, channel: r.channel, body: r.body,
    author: r.author, status: r.status, createdAt: new Date(r.created_at).toISOString(),
    providerMessageId: r.provider_message_id,
  }));
}

/**
 * Human takeover. While a conversation is human_active the AI must not send: the
 * orchestrator checks this state before every reply.
 */
export async function takeOver(db: Queryable, tenantId: string, conversationId: string, userId: string): Promise<void> {
  await db.query(
    `UPDATE conversations SET state='human_active', assigned_user_id=$3 WHERE tenant_id=$1 AND id=$2`,
    [tenantId, conversationId, userId],
  );
  await audit(
    { tenantId, actor: "operator", actorUserId: userId, action: "conversation.taken_over", entity: "conversation", entityId: conversationId },
    db,
  );
}

export async function releaseToAi(db: Queryable, tenantId: string, conversationId: string, userId: string): Promise<void> {
  await db.query(
    `UPDATE conversations SET state='ai_active', assigned_user_id=NULL WHERE tenant_id=$1 AND id=$2`,
    [tenantId, conversationId],
  );
  await audit(
    { tenantId, actor: "operator", actorUserId: userId, action: "conversation.released", entity: "conversation", entityId: conversationId },
    db,
  );
}

export async function listConversations(
  db: Queryable,
  tenantId: string,
  opts: { state?: ConversationState; limit?: number } = {},
) {
  const vals: unknown[] = [tenantId];
  let where = "c.tenant_id = $1";
  if (opts.state) {
    vals.push(opts.state);
    where += ` AND c.state = $${vals.length}`;
  }
  vals.push(opts.limit ?? 50);
  const { rows } = await db.query(
    `SELECT c.id, c.channel, c.state, c.last_message_at, c.last_inbound_at,
            cu.display_name, cu.phone_e164, cu.instagram_id,
            (SELECT body FROM messages m WHERE m.conversation_id = c.id ORDER BY m.created_at DESC LIMIT 1) AS last_body
       FROM conversations c
       JOIN customers cu ON cu.id = c.customer_id
      WHERE ${where}
      ORDER BY c.last_message_at DESC NULLS LAST
      LIMIT $${vals.length}`,
    vals,
  );
  return rows.map((r: any) => ({
    id: r.id,
    channel: r.channel,
    state: r.state,
    lastMessageAt: r.last_message_at ? new Date(r.last_message_at).toISOString() : null,
    withinServiceWindow: withinServiceWindow(r.last_inbound_at),
    customer: { displayName: r.display_name, phoneE164: r.phone_e164, instagramId: r.instagram_id },
    lastBody: r.last_body,
  }));
}

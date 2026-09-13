import type { Queryable } from "../db/index.js";
import type { MessagingProvider } from "../channels/types.js";
import { recordMessage } from "./conversations.js";
import { audit } from "../core/audit.js";

export const MAX_ATTEMPTS = 6;

/** Exponential backoff with a ceiling: 30s, 60s, 2m, 4m, 8m, capped at 15m. */
export function backoffMs(attempt: number): number {
  return Math.min(30_000 * 2 ** Math.max(0, attempt - 1), 900_000);
}

export type EnqueueInput = {
  conversationId?: string | null;
  messageId?: string | null;
  channel: string;
  to: string;
  body?: string | null;
  template?: { name: string; language: string; variables?: string[] } | null;
  idempotencyKey?: string | null;
};

/**
 * Enqueue is idempotent on idempotencyKey: a retried follow-up job or a double-clicked
 * operator send results in one queued message, not two.
 */
export async function enqueue(db: Queryable, tenantId: string, input: EnqueueInput): Promise<{ id: string; created: boolean }> {
  const { rows } = await db.query(
    `INSERT INTO outbox (tenant_id, conversation_id, message_id, channel, to_address, body, template, idempotency_key)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (tenant_id, idempotency_key) DO NOTHING
     RETURNING id`,
    [
      tenantId, input.conversationId ?? null, input.messageId ?? null, input.channel,
      input.to, input.body ?? null, input.template ? JSON.stringify(input.template) : null,
      input.idempotencyKey ?? null,
    ],
  );
  if (rows[0]) return { id: rows[0].id, created: true };
  const { rows: dup } = await db.query(
    `SELECT id FROM outbox WHERE tenant_id=$1 AND idempotency_key=$2`,
    [tenantId, input.idempotencyKey],
  );
  return { id: dup[0].id, created: false };
}

export type DrainResult = { sent: number; failed: number; dead: number; skipped: number };

/**
 * Sends everything currently due. A retryable failure is rescheduled with backoff;
 * a permanent one (bad number, rejected template) is marked dead immediately rather
 * than burning six attempts on it.
 */
export async function drainOutbox(
  db: Queryable,
  tenantId: string,
  provider: MessagingProvider,
  opts: { now?: Date; limit?: number } = {},
): Promise<DrainResult> {
  const now = opts.now ?? new Date();
  const result: DrainResult = { sent: 0, failed: 0, dead: 0, skipped: 0 };

  const { rows } = await db.query(
    `SELECT id, conversation_id, message_id, channel, to_address, body, template, attempt
       FROM outbox
      WHERE tenant_id=$1 AND status='pending' AND next_attempt_at <= $2
      ORDER BY next_attempt_at
      LIMIT $3
      FOR UPDATE SKIP LOCKED`,
    [tenantId, now.toISOString(), opts.limit ?? 25],
  );

  for (const row of rows) {
    if (!provider.isConfigured()) {
      // Leave it pending. An unconfigured channel is NOT_CONNECTED, not a failure —
      // the message must still be there to send once credentials arrive.
      result.skipped++;
      continue;
    }

    const attempt = row.attempt + 1;
    const tpl = row.template as { name: string; language: string; variables?: string[] } | null;
    const send = tpl && provider.sendTemplate
      ? await provider.sendTemplate({ to: row.to_address, templateName: tpl.name, languageCode: tpl.language, variables: tpl.variables })
      : await provider.sendText({ to: row.to_address, body: row.body ?? "" });

    if (send.ok) {
      await db.query(`UPDATE outbox SET status='sent', attempt=$3 WHERE tenant_id=$1 AND id=$2`, [tenantId, row.id, attempt]);
      if (row.message_id) {
        await db.query(
          `UPDATE messages SET status='sent', provider_message_id=COALESCE(provider_message_id,$3)
            WHERE tenant_id=$1 AND id=$2`,
          [tenantId, row.message_id, send.providerMessageId],
        );
      }
      result.sent++;
      continue;
    }

    const permanent = !send.retryable;
    const exhausted = attempt >= MAX_ATTEMPTS;
    if (permanent || exhausted) {
      await db.query(
        `UPDATE outbox SET status='dead', attempt=$3, last_error=$4 WHERE tenant_id=$1 AND id=$2`,
        [tenantId, row.id, attempt, send.error],
      );
      if (row.message_id) {
        await db.query(`UPDATE messages SET status='failed', error=$3 WHERE tenant_id=$1 AND id=$2`, [
          tenantId, row.message_id, send.error,
        ]);
      }
      await audit({ tenantId, actor: "system", action: "outbox.dead", entity: "outbox", entityId: row.id, data: { error: send.error, attempt } }, db);
      result.dead++;
    } else {
      const next = new Date(now.getTime() + backoffMs(attempt));
      await db.query(
        `UPDATE outbox SET attempt=$3, next_attempt_at=$4, last_error=$5 WHERE tenant_id=$1 AND id=$2`,
        [tenantId, row.id, attempt, next.toISOString(), send.error],
      );
      result.failed++;
    }
  }
  return result;
}

/** Convenience used by the engine: persist the outbound message then queue the send. */
export async function queueReply(
  db: Queryable,
  tenantId: string,
  input: {
    conversationId: string;
    channel: "whatsapp" | "instagram" | "web";
    to: string;
    body: string;
    author: "ai" | "operator" | "system";
    authorUserId?: string | null;
    idempotencyKey?: string | null;
  },
): Promise<{ messageId: string; outboxId: string }> {
  const msg = await recordMessage(db, tenantId, {
    conversationId: input.conversationId,
    direction: "outbound",
    channel: input.channel,
    body: input.body,
    author: input.author,
    authorUserId: input.authorUserId ?? null,
    status: "queued",
  });
  const out = await enqueue(db, tenantId, {
    conversationId: input.conversationId,
    messageId: msg.id,
    channel: input.channel,
    to: input.to,
    body: input.body,
    idempotencyKey: input.idempotencyKey ?? `msg:${msg.id}`,
  });
  return { messageId: msg.id, outboxId: out.id };
}

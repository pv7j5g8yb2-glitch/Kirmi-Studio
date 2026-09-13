import type { Queryable } from "../db/index.js";
import { audit } from "../core/audit.js";
import { withinServiceWindow } from "./conversations.js";
import { enqueue } from "./outbox.js";

export type FollowupKind =
  | "quote_followup" | "reactivation" | "document_chase" | "pickup_reminder" | "dropoff_reminder";

/**
 * Follow-up and reactivation — the part that earns the retainer.
 *
 * WhatsApp only allows free-form text within 24h of the customer's last message.
 * Anything later must use an approved template, so every scheduled item records
 * which side of that line it will land on and the sender honours it.
 */

export const DEFAULT_SCHEDULE: Record<FollowupKind, number[]> = {
  // hours after the trigger
  quote_followup: [4, 24, 72],
  reactivation: [24 * 14],
  document_chase: [2, 12],
  pickup_reminder: [-24],
  dropoff_reminder: [-4],
};

const COPY: Record<FollowupKind, { en: (v: Vars) => string; ar: (v: Vars) => string; template: string }> = {
  quote_followup: {
    en: (v) => `Hi${v.name ? ` ${v.name}` : ""}, still interested in the ${v.vehicle}? I can hold it on your dates.`,
    ar: (v) => `مرحباً${v.name ? ` ${v.name}` : ""}، هل ما زلت مهتماً بـ${v.vehicle}؟ أستطيع حجزها على تواريخك.`,
    template: "quote_followup",
  },
  reactivation: {
    en: (v) => `Hi${v.name ? ` ${v.name}` : ""}, you asked about the ${v.vehicle} with us before. It is available again if you still need a car.`,
    ar: (v) => `مرحباً${v.name ? ` ${v.name}` : ""}، سألت سابقاً عن ${v.vehicle}. أصبحت متاحة مجدداً إن كنت ما زلت بحاجة لسيارة.`,
    template: "reactivation",
  },
  document_chase: {
    en: () => `Just the documents left to complete your booking. Please send your passport and driving licence when you can.`,
    ar: () => `بقيت المستندات فقط لإتمام الحجز. يرجى إرسال جواز السفر ورخصة القيادة عندما يتيسر لك.`,
    template: "document_chase",
  },
  pickup_reminder: {
    en: (v) => `Reminder: your ${v.vehicle} is ready tomorrow. Please bring your passport and driving licence.`,
    ar: (v) => `تذكير: ${v.vehicle} جاهزة غداً. يرجى إحضار جواز السفر ورخصة القيادة.`,
    template: "pickup_reminder",
  },
  dropoff_reminder: {
    en: (v) => `Reminder: your ${v.vehicle} is due back in a few hours.`,
    ar: (v) => `تذكير: موعد إرجاع ${v.vehicle} بعد ساعات قليلة.`,
    template: "dropoff_reminder",
  },
};

type Vars = { name?: string | null; vehicle?: string | null };

export async function scheduleFollowups(
  db: Queryable,
  tenantId: string,
  input: { conversationId: string; enquiryId?: string | null; kind: FollowupKind; anchor?: Date; payload?: Record<string, unknown> },
): Promise<string[]> {
  const anchor = input.anchor ?? new Date();
  const ids: string[] = [];
  for (const hours of DEFAULT_SCHEDULE[input.kind]) {
    const due = new Date(anchor.getTime() + hours * 3_600_000);
    const { rows } = await db.query(
      `INSERT INTO followups (tenant_id, conversation_id, enquiry_id, kind, due_at, payload)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [tenantId, input.conversationId, input.enquiryId ?? null, input.kind, due.toISOString(), JSON.stringify(input.payload ?? {})],
    );
    ids.push(rows[0].id);
  }
  return ids;
}

/** Cancels pending follow-ups once the customer replies or the booking completes. */
export async function cancelFollowups(
  db: Queryable, tenantId: string, conversationId: string, kinds?: FollowupKind[],
): Promise<number> {
  const vals: unknown[] = [tenantId, conversationId];
  let extra = "";
  if (kinds?.length) { vals.push(kinds); extra = ` AND kind = ANY($3)`; }
  const { rowCount } = await db.query(
    `UPDATE followups SET status='cancelled', updated_at=now()
      WHERE tenant_id=$1 AND conversation_id=$2 AND status='scheduled'${extra}`,
    vals,
  );
  return rowCount ?? 0;
}

export type RunResult = { sent: number; skipped: number; templateRequired: number };

/**
 * Sends everything due. Outside the 24-hour window a free-form send would be rejected
 * by Meta, so those are queued as template sends instead — and if the tenant has no
 * approved template they are skipped, not silently dropped into the void.
 */
export async function runDueFollowups(
  db: Queryable,
  tenantId: string,
  opts: { now?: Date; approvedTemplates?: string[] } = {},
): Promise<RunResult> {
  const now = opts.now ?? new Date();
  const approved = new Set(opts.approvedTemplates ?? []);
  const result: RunResult = { sent: 0, skipped: 0, templateRequired: 0 };

  const { rows } = await db.query(
    `SELECT f.id, f.kind, f.conversation_id, f.enquiry_id, f.payload, f.attempt,
            c.channel, c.state AS conv_state, c.last_inbound_at, c.locale,
            cu.display_name, cu.phone_e164, cu.instagram_id
       FROM followups f
       JOIN conversations c ON c.id = f.conversation_id
       JOIN customers cu ON cu.id = c.customer_id
      WHERE f.tenant_id = $1 AND f.status = 'scheduled' AND f.due_at <= $2
      ORDER BY f.due_at
      LIMIT 100
      FOR UPDATE OF f SKIP LOCKED`,
    [tenantId, now.toISOString()],
  );

  for (const row of rows) {
    // Never follow up on a conversation a person is handling.
    if (row.conv_state === "human_active" || row.conv_state === "closed") {
      await db.query(`UPDATE followups SET status='skipped', updated_at=now() WHERE tenant_id=$1 AND id=$2`, [tenantId, row.id]);
      result.skipped++;
      continue;
    }

    const to = row.channel === "instagram" ? row.instagram_id : row.phone_e164;
    if (!to) {
      await db.query(`UPDATE followups SET status='failed', last_error='no address', updated_at=now() WHERE tenant_id=$1 AND id=$2`, [tenantId, row.id]);
      result.skipped++;
      continue;
    }

    const locale: "en" | "ar" = row.locale === "ar" ? "ar" : "en";
    const vars: Vars = { name: row.display_name, vehicle: (row.payload?.vehicle as string) ?? "the car" };
    const copy = COPY[row.kind as FollowupKind];
    const body = copy[locale](vars);

    const inWindow = row.channel !== "whatsapp" || withinServiceWindow(row.last_inbound_at, now);
    if (!inWindow) {
      result.templateRequired++;
      if (!approved.has(copy.template)) {
        await db.query(
          `UPDATE followups SET status='skipped', requires_template=true, template_name=$3,
                  last_error='outside 24h window and no approved template', updated_at=now()
            WHERE tenant_id=$1 AND id=$2`,
          [tenantId, row.id, copy.template],
        );
        result.skipped++;
        continue;
      }
      await enqueue(db, tenantId, {
        conversationId: row.conversation_id,
        channel: row.channel,
        to,
        template: { name: copy.template, language: locale, variables: [vars.name ?? "", vars.vehicle ?? ""] },
        idempotencyKey: `followup:${row.id}`,
      });
    } else {
      await enqueue(db, tenantId, {
        conversationId: row.conversation_id,
        channel: row.channel,
        to,
        body,
        idempotencyKey: `followup:${row.id}`,
      });
    }

    await db.query(
      `UPDATE followups SET status='sent', attempt=attempt+1, requires_template=$3, template_name=$4, updated_at=now()
        WHERE tenant_id=$1 AND id=$2`,
      [tenantId, row.id, !inWindow, !inWindow ? copy.template : null],
    );
    await audit({ tenantId, actor: "system", action: "followup.sent", entity: "followup", entityId: row.id, data: { kind: row.kind, viaTemplate: !inWindow } }, db);
    result.sent++;
  }
  return result;
}

/**
 * Reactivation sweep: everyone who enquired, never booked, and has gone quiet.
 * This is the "bring back past enquiries" promise, implemented as a real query.
 */
export async function scheduleReactivations(
  db: Queryable,
  tenantId: string,
  opts: { quietForDays?: number; limit?: number; now?: Date } = {},
): Promise<number> {
  const quietDays = opts.quietForDays ?? 14;
  const now = opts.now ?? new Date();
  const cutoff = new Date(now.getTime() - quietDays * 86_400_000);

  const { rows } = await db.query(
    `SELECT e.id AS enquiry_id, e.conversation_id, v.make, v.model
       FROM enquiries e
       JOIN conversations c ON c.id = e.conversation_id
       LEFT JOIN LATERAL (
         SELECT q.vehicle_id FROM quotes q WHERE q.enquiry_id = e.id ORDER BY q.created_at DESC LIMIT 1
       ) lq ON true
       LEFT JOIN vehicles v ON v.id = lq.vehicle_id
      WHERE e.tenant_id = $1
        AND e.status IN ('open','qualified','quoted')
        AND c.state = 'ai_active'
        AND c.last_message_at < $2
        AND NOT EXISTS (
          SELECT 1 FROM reservations r
           WHERE r.tenant_id = e.tenant_id AND r.customer_id = e.customer_id
             AND r.state IN ('confirmed','completed')
        )
        AND NOT EXISTS (
          SELECT 1 FROM followups f
           WHERE f.tenant_id = e.tenant_id AND f.enquiry_id = e.id AND f.kind = 'reactivation'
        )
      ORDER BY c.last_message_at
      LIMIT $3`,
    [tenantId, cutoff.toISOString(), opts.limit ?? 50],
  );

  let scheduled = 0;
  for (const r of rows) {
    const vehicle = r.make ? `${r.make} ${r.model}` : null;
    await db.query(
      `INSERT INTO followups (tenant_id, conversation_id, enquiry_id, kind, due_at, payload)
       VALUES ($1,$2,$3,'reactivation',$4,$5)`,
      [tenantId, r.conversation_id, r.enquiry_id, now.toISOString(), JSON.stringify({ vehicle })],
    );
    scheduled++;
  }
  return scheduled;
}

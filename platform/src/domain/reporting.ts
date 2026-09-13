import type { Queryable } from "../db/index.js";

/**
 * Revenue attribution and the monthly report the marketing site promises.
 *
 * Attribution is deliberately conservative: a booking counts as Kirmi-influenced only
 * when its conversation actually carries Kirmi-authored messages. Revenue reported is
 * confirmed revenue — never quotes, never holds — because the brief forbids presenting
 * estimates as results.
 */

export type Period = { from: Date; to: Date };

export function monthPeriod(year: number, month1to12: number): Period {
  const from = new Date(Date.UTC(year, month1to12 - 1, 1));
  const to = new Date(Date.UTC(year, month1to12, 1));
  return { from, to };
}

export type MonthlyReport = {
  period: { from: string; to: string };
  enquiries: number;
  uniqueCustomers: number;
  quotes: number;
  reservationsConfirmed: number;
  confirmedRevenue: number;
  currency: string;
  conversionRatePct: number;
  medianFirstResponseSeconds: number | null;
  recoveredBookings: number;
  recoveredRevenue: number;
  escalations: number;
  byChannel: Array<{ channel: string; enquiries: number; confirmed: number }>;
  aiHandledPct: number;
};

export async function monthlyReport(db: Queryable, tenantId: string, period: Period): Promise<MonthlyReport> {
  const p = [tenantId, period.from.toISOString(), period.to.toISOString()];

  const { rows: enq } = await db.query(
    `SELECT count(*)::int AS n, count(DISTINCT customer_id)::int AS customers
       FROM enquiries WHERE tenant_id=$1 AND created_at >= $2 AND created_at < $3`,
    p,
  );

  const { rows: quo } = await db.query(
    `SELECT count(*)::int AS n FROM quotes WHERE tenant_id=$1 AND created_at >= $2 AND created_at < $3`,
    p,
  );

  const { rows: res } = await db.query(
    `SELECT count(*)::int AS n, COALESCE(sum(total),0)::bigint AS revenue, currency
       FROM reservations
      WHERE tenant_id=$1 AND confirmed_at >= $2 AND confirmed_at < $3
        AND state IN ('confirmed','completed')
      GROUP BY currency`,
    p,
  );

  // First response time: inbound to the first Kirmi reply on the same conversation.
  const { rows: frt } = await db.query(
    `SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY secs) AS median FROM (
       SELECT EXTRACT(EPOCH FROM (MIN(out.created_at) - inn.created_at)) AS secs
         FROM messages inn
         JOIN messages out
           ON out.conversation_id = inn.conversation_id
          AND out.direction = 'outbound'
          AND out.created_at > inn.created_at
        WHERE inn.tenant_id = $1 AND inn.direction = 'inbound'
          AND inn.created_at >= $2 AND inn.created_at < $3
        GROUP BY inn.id, inn.created_at
     ) t`,
    p,
  );

  // Recovered = confirmed after a follow-up or reactivation touched that conversation.
  const { rows: rec } = await db.query(
    `SELECT count(DISTINCT r.id)::int AS n, COALESCE(sum(DISTINCT r.total),0)::bigint AS revenue
       FROM reservations r
       JOIN quotes q ON q.id = r.quote_id
       JOIN enquiries e ON e.id = q.enquiry_id
       JOIN followups f ON f.conversation_id = e.conversation_id
      WHERE r.tenant_id = $1
        AND r.confirmed_at >= $2 AND r.confirmed_at < $3
        AND r.state IN ('confirmed','completed')
        AND f.status = 'sent'
        AND f.kind IN ('quote_followup','reactivation')
        AND f.updated_at < r.confirmed_at`,
    p,
  );

  const { rows: esc } = await db.query(
    `SELECT count(*)::int AS n FROM audit_log
      WHERE tenant_id=$1 AND action='conversation.escalated' AND created_at >= $2 AND created_at < $3`,
    p,
  );

  const { rows: chan } = await db.query(
    `SELECT e.channel,
            count(DISTINCT e.id)::int AS enquiries,
            count(DISTINCT r.id) FILTER (WHERE r.state IN ('confirmed','completed'))::int AS confirmed
       FROM enquiries e
       LEFT JOIN quotes q ON q.enquiry_id = e.id
       LEFT JOIN reservations r ON r.quote_id = q.id
      WHERE e.tenant_id=$1 AND e.created_at >= $2 AND e.created_at < $3
      GROUP BY e.channel ORDER BY enquiries DESC`,
    p,
  );

  const { rows: ai } = await db.query(
    `SELECT
        count(*) FILTER (WHERE author='ai')::int AS ai,
        count(*) FILTER (WHERE direction='outbound')::int AS total
       FROM messages WHERE tenant_id=$1 AND created_at >= $2 AND created_at < $3`,
    p,
  );

  const enquiries = enq[0]?.n ?? 0;
  const confirmed = res.reduce((a: number, r: any) => a + r.n, 0);
  const revenue = res.reduce((a: number, r: any) => a + Number(r.revenue), 0);
  const outbound = ai[0]?.total ?? 0;

  return {
    period: { from: period.from.toISOString(), to: period.to.toISOString() },
    enquiries,
    uniqueCustomers: enq[0]?.customers ?? 0,
    quotes: quo[0]?.n ?? 0,
    reservationsConfirmed: confirmed,
    confirmedRevenue: revenue,
    currency: res[0]?.currency ?? "AED",
    conversionRatePct: enquiries ? Math.round((confirmed / enquiries) * 1000) / 10 : 0,
    medianFirstResponseSeconds: frt[0]?.median !== null && frt[0]?.median !== undefined ? Math.round(Number(frt[0].median)) : null,
    recoveredBookings: rec[0]?.n ?? 0,
    recoveredRevenue: Number(rec[0]?.revenue ?? 0),
    escalations: esc[0]?.n ?? 0,
    byChannel: chan.map((c: any) => ({ channel: c.channel, enquiries: c.enquiries, confirmed: c.confirmed })),
    aiHandledPct: outbound ? Math.round(((ai[0]?.ai ?? 0) / outbound) * 1000) / 10 : 0,
  };
}

/** Live counters for the operator console header. */
export async function liveStats(db: Queryable, tenantId: string) {
  const { rows } = await db.query(
    `SELECT
       (SELECT count(*)::int FROM conversations WHERE tenant_id=$1 AND state='ai_active') AS ai_active,
       (SELECT count(*)::int FROM conversations WHERE tenant_id=$1 AND state='human_active') AS needs_human,
       (SELECT count(*)::int FROM enquiries WHERE tenant_id=$1 AND created_at > now() - interval '24 hours') AS enquiries_24h,
       (SELECT count(*)::int FROM reservations WHERE tenant_id=$1 AND state IN ('held','documents_pending','payment_pending')) AS open_reservations,
       (SELECT count(*)::int FROM outbox WHERE tenant_id=$1 AND status='pending') AS outbox_pending,
       (SELECT count(*)::int FROM outbox WHERE tenant_id=$1 AND status='dead') AS outbox_dead,
       (SELECT count(*)::int FROM followups WHERE tenant_id=$1 AND status='scheduled' AND due_at <= now()) AS followups_due`,
    [tenantId],
  );
  return rows[0];
}

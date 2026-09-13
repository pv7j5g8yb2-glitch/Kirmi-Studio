import { applyBasisPoints, type Minor } from "../core/money.js";
import type { TenantProfile } from "../core/types.js";
import type { TenantDatabase } from "../db/tenant-context.js";

/**
 * ===========================================================================
 * THE FOUR METRIC CHANNELS
 * ===========================================================================
 *
 * What the client's dashboard shows, and what Kirmi Studio invoices against:
 *
 *   1. Enquiries received
 *   2. Bookings secured
 *   3. Total tracked revenue
 *   4. Kirmi B2B fee generated
 *
 * Every one of them is derived by replaying platform_audit_logs. Nothing is
 * stored as a running total anywhere, which means the dashboard and the invoice
 * cannot disagree, and a disputed figure can be walked back to the individual
 * events that produced it.
 *
 * Revenue is reported gross, cancelled and net rather than as one number. A
 * cancelled booking did happen, the engine did convert it, and the client's
 * cash did not arrive. One figure cannot honestly say all three, and a client
 * who discovers the difference on their own stops trusting the dashboard.
 */

export interface MetricsWindow {
  from: Date;
  to: Date;
}

export interface MetricsSnapshot {
  window: { from: string; to: string };
  currency: string;

  enquiriesReceived: number;
  bookingsSecured: number;

  revenue: {
    grossMinor: Minor;
    cancelledMinor: Minor;
    netMinor: Minor;
  };

  kirmiFee: {
    commissionMinor: Minor;
    retainerMinor: Minor;
    totalMinor: Minor;
    feeModel: TenantProfile["billing"]["feeModel"];
  };

  /** Context the four headline numbers need to mean anything. */
  context: {
    conversionRatePercent: number;
    averageBookingValueMinor: Minor;
    holdsCreated: number;
    escalations: number;
    medianReplyMs: number | null;
    slaBreaches: number;
  };
}

export interface DailyPoint {
  date: string;
  enquiries: number;
  bookings: number;
  revenueMinor: Minor;
}

export class MetricsService {
  constructor(private readonly db: TenantDatabase) {}

  async snapshot(tenant: TenantProfile, window: MetricsWindow): Promise<MetricsSnapshot> {
    return this.db.withTenant(tenant.clientId, async (tx) => {
      const occurredAt = { gte: window.from, lte: window.to };

      // Counts by event type in one grouped pass rather than four round trips.
      const grouped = await tx.platformAuditLog.groupBy({
        by: ["eventType"],
        where: { occurredAt },
        _count: { _all: true },
        _sum: { revenueMinor: true, kirmiFeeMinor: true },
      });

      const bucket = (type: string) => grouped.find((g) => g.eventType === type);

      const enquiriesReceived = bucket("ENQUIRY_RECEIVED")?._count._all ?? 0;
      const securedBucket = bucket("BOOKING_SECURED");
      const bookingsSecured = securedBucket?._count._all ?? 0;
      const grossMinor = securedBucket?._sum.revenueMinor ?? 0;
      const commissionMinor = securedBucket?._sum.kirmiFeeMinor ?? 0;

      // Cancellations are netted from the reservation rows rather than from a
      // negative ledger entry, so SUM(revenue_minor) stays an honest gross.
      const cancelled = await tx.reservation.aggregate({
        where: { status: "CANCELLED", confirmedAt: { not: null }, cancelledAt: occurredAt },
        _sum: { totalMinor: true },
      });
      const cancelledMinor = cancelled._sum.totalMinor ?? 0;

      const holdsCreated = bucket("HOLD_CREATED")?._count._all ?? 0;
      const escalations = bucket("HUMAN_ESCALATION")?._count._all ?? 0;

      const retainerMinor = this.retainerForWindow(tenant, window);

      const latency = await this.replyLatency(tx, window);

      return {
        window: { from: window.from.toISOString(), to: window.to.toISOString() },
        currency: tenant.currency,

        enquiriesReceived,
        bookingsSecured,

        revenue: {
          grossMinor,
          cancelledMinor,
          netMinor: grossMinor - cancelledMinor,
        },

        kirmiFee: {
          commissionMinor,
          retainerMinor,
          totalMinor: commissionMinor + retainerMinor,
          feeModel: tenant.billing.feeModel,
        },

        context: {
          conversionRatePercent:
            enquiriesReceived === 0 ? 0 : Math.round((bookingsSecured / enquiriesReceived) * 1000) / 10,
          averageBookingValueMinor: bookingsSecured === 0 ? 0 : Math.round(grossMinor / bookingsSecured),
          holdsCreated,
          escalations,
          medianReplyMs: latency.medianMs,
          slaBreaches: latency.breaches,
        },
      };
    });
  }

  /**
   * Daily buckets for the dashboard chart.
   *
   * Bucketed in the client's own timezone. A Dubai booking at 01:00 local is
   * the previous day in UTC, and a chart that quietly reassigns a fifth of the
   * week's bookings to the wrong day is worse than no chart.
   */
  async daily(tenant: TenantProfile, window: MetricsWindow): Promise<DailyPoint[]> {
    return this.db.withTenant(tenant.clientId, async (tx) => {
      const rows = await tx.$queryRaw<Array<{ date: string; enquiries: bigint; bookings: bigint; revenue: bigint | null }>>`
        SELECT
          to_char(date_trunc('day', occurred_at AT TIME ZONE ${tenant.timezone}), 'YYYY-MM-DD') AS date,
          count(*) FILTER (WHERE event_type = 'ENQUIRY_RECEIVED') AS enquiries,
          count(*) FILTER (WHERE event_type = 'BOOKING_SECURED')  AS bookings,
          coalesce(sum(revenue_minor) FILTER (WHERE event_type = 'BOOKING_SECURED'), 0) AS revenue
        FROM platform_audit_logs
        WHERE occurred_at >= ${window.from} AND occurred_at <= ${window.to}
        GROUP BY 1
        ORDER BY 1 ASC
      `;

      return rows.map((r) => ({
        date: r.date,
        enquiries: Number(r.enquiries),
        bookings: Number(r.bookings),
        revenueMinor: Number(r.revenue ?? 0),
      }));
    });
  }

  /**
   * Reply latency against the SLA.
   *
   * Median rather than mean on purpose: one 40 second outlier drags a mean
   * enough to hide a fleet that is otherwise answering in two seconds, and the
   * promise made to the client is about the typical reply.
   */
  private async replyLatency(
    tx: Parameters<Parameters<TenantDatabase["withTenant"]>[1]>[0],
    window: MetricsWindow,
  ): Promise<{ medianMs: number | null; breaches: number }> {
    const rows = await tx.$queryRaw<Array<{ median: number | null; breaches: bigint }>>`
      SELECT
        percentile_cont(0.5) WITHIN GROUP (ORDER BY latency_ms) AS median,
        count(*) FILTER (WHERE sla_breached) AS breaches
      FROM messages
      WHERE direction = 'OUTBOUND'
        AND created_at >= ${window.from} AND created_at <= ${window.to}
    `;
    const row = rows[0];
    return {
      medianMs: row?.median === null || row?.median === undefined ? null : Math.round(row.median),
      breaches: Number(row?.breaches ?? 0),
    };
  }

  /**
   * The retainer portion of Kirmi's fee for a window.
   *
   * Pro-rated per calendar month by the days the window actually covers.
   *
   * The naive version, counting whole calendar months touched, is wrong for the
   * view people actually look at. The dashboard defaults to the last 30 days,
   * which almost always straddles two calendar months, so "months touched"
   * reports two months of retainer every single day of the year. A client who
   * notices that stops believing the rest of the page.
   *
   * Pro-rating is exact where it matters: a window covering one whole calendar
   * month returns precisely one retainer, so an invoice period reconciles to the
   * penny, and a rolling 30 day window returns roughly one, which is the truth.
   */
  private retainerForWindow(tenant: TenantProfile, window: MetricsWindow): Minor {
    const retainer = tenant.billing.retainerMinor;
    if (tenant.billing.feeModel === "COMMISSION" || retainer === 0) return 0;

    let accrued = 0;
    // Walk the calendar months the window touches, in UTC.
    const cursor = new Date(Date.UTC(window.from.getUTCFullYear(), window.from.getUTCMonth(), 1));

    while (cursor.getTime() <= window.to.getTime()) {
      const monthStart = cursor.getTime();
      const monthEnd = Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 1);
      const daysInMonth = (monthEnd - monthStart) / 86_400_000;

      const coveredFrom = Math.max(monthStart, window.from.getTime());
      const coveredTo = Math.min(monthEnd, window.to.getTime());
      const coveredDays = Math.max(0, (coveredTo - coveredFrom) / 86_400_000);

      accrued += Math.round((retainer * coveredDays) / daysInMonth);

      cursor.setUTCMonth(cursor.getUTCMonth() + 1);
    }

    return accrued;
  }

  /**
   * What a booking of this size would earn Kirmi, without writing anything.
   * Used by the dashboard to show the fee alongside a live quote.
   */
  projectedFee(tenant: TenantProfile, bookingValueMinor: Minor): Minor {
    if (tenant.billing.feeModel === "RETAINER") return 0;
    return applyBasisPoints(bookingValueMinor, tenant.billing.commissionBasisPoints);
  }
}

import type { Logger } from "../core/logger.js";
import { formatMoney, type Minor } from "../core/money.js";
import type { TenantDatabase, TenantTx } from "../db/tenant-context.js";

/**
 * ===========================================================================
 * WHICH BOOKINGS ARE OURS
 * ===========================================================================
 *
 * Kirmi Studio's commission agreement pays on bookings the engine produced.
 * That sentence is the whole commercial relationship, so the rule behind it has
 * to be mechanical, checkable by the client, and impossible to argue about at
 * the end of the month.
 *
 * THE RULE
 *
 *   A reservation is attributed when it came out of a conversation the engine
 *   handled, and no member of the client's team took that conversation over
 *   BEFORE the quote was issued.
 *
 * The "before the quote" clause is the important half, and it is deliberately
 * generous to the client in one direction and protective in the other.
 *
 * If a human takes a conversation over at the start, the work was theirs and
 * nothing is owed. But once the engine has understood the request, checked real
 * availability and put a price in front of the customer, the work is done: a
 * salesperson who then steps in to close does not erase it. Attributing on
 * "no human touched this, ever" would hand the client a lever to zero the
 * invoice by having staff open every thread, which is a bad incentive to build
 * into a partnership that is supposed to run for years.
 *
 * Nothing here is inferred or scored. Every field it reads is a timestamp
 * written by the engine at the moment it happened, which is why the report can
 * be handed to a client line by line and survive being checked.
 */

export interface AttributedBooking {
  reservationId: string;
  reference: string;
  status: string;
  vehicle: string;
  plateNumber: string;
  startAt: Date;
  endAt: Date;
  durationDays: number;
  /** Excludes VAT and the refundable deposit: commission is on the rental. */
  rentalValueMinor: Minor;
  currency: string;
  quotedAt: Date | null;
  confirmedAt: Date | null;
  channel: string;
  /** Present when a human joined after the quote. Recorded, not penalised. */
  humanJoinedAt: Date | null;
}

export interface AttributionReport {
  clientId: string;
  from: Date;
  to: Date;
  bookings: AttributedBooking[];
  /** Bookings in the window the engine did NOT produce, with the reason. Shown
   *  because a report that only lists what we are owed invites the question of
   *  what was left out, and answering it up front ends the conversation. */
  excluded: Array<{ reference: string; reason: string }>;
  totals: {
    bookingCount: number;
    rentalValueMinor: Minor;
    commissionBasisPoints: number;
    commissionMinor: Minor;
    currency: string;
  };
}

export class AttributionService {
  constructor(
    private readonly db: TenantDatabase,
    private readonly log: Logger,
  ) {}

  /**
   * Build the report for an invoice period.
   *
   * Dated by when the booking was CREATED, not when the rental starts. A car
   * booked on the 28th for a rental in November was won in October, and the
   * period that did the work is the period that gets paid.
   */
  async report(
    clientId: string,
    from: Date,
    to: Date,
    commissionBasisPoints: number,
    currency = "AED",
  ): Promise<AttributionReport> {
    return this.db.withTenant(clientId, async (tx: TenantTx) => {
      const reservations = await tx.reservation.findMany({
        where: {
          clientId,
          createdAt: { gte: from, lt: to },
          // A cancelled hold was never revenue. An expired one even less so.
          status: { in: ["HOLD", "CONFIRMED", "COMPLETED"] },
        },
        orderBy: { createdAt: "asc" },
        include: {
          vehicle: { select: { make: true, model: true, year: true, plateNumber: true } },
          conversation: { select: { channel: true, takeoverAt: true, aiEnabled: true } },
          quote: { select: { createdAt: true } },
        },
      });

      const bookings: AttributedBooking[] = [];
      const excluded: Array<{ reference: string; reason: string }> = [];

      for (const r of reservations) {
        const verdict = classify(r);
        if (!verdict.attributed) {
          excluded.push({ reference: r.reference, reason: verdict.reason });
          continue;
        }

        bookings.push({
          reservationId: r.id,
          reference: r.reference,
          status: r.status,
          vehicle: `${r.vehicle.year} ${r.vehicle.make} ${r.vehicle.model}`,
          plateNumber: r.vehicle.plateNumber,
          startAt: r.startAt,
          endAt: r.endAt,
          durationDays: r.durationDays,
          // totalMinor carries VAT; the commission is on the rental itself.
          rentalValueMinor: r.totalMinor - r.vatMinor,
          currency: r.currency,
          quotedAt: r.quote?.createdAt ?? null,
          confirmedAt: r.confirmedAt,
          channel: r.conversation?.channel ?? "UNKNOWN",
          humanJoinedAt: r.conversation?.takeoverAt ?? null,
        });
      }

      const rentalValueMinor = bookings.reduce((sum, b) => sum + b.rentalValueMinor, 0);
      // Integer arithmetic throughout: basis points and a floor, never a float
      // multiplication that produces 8099.999999 on an invoice.
      const commissionMinor = Math.floor((rentalValueMinor * commissionBasisPoints) / 10_000);

      this.log.info(
        { clientId, from, to, attributed: bookings.length, excluded: excluded.length, commissionMinor },
        "attribution report built",
      );

      return {
        clientId,
        from,
        to,
        bookings,
        excluded,
        totals: {
          bookingCount: bookings.length,
          rentalValueMinor,
          commissionBasisPoints,
          commissionMinor,
          currency,
        },
      };
    });
  }
}

interface Classifiable {
  conversationId: string | null;
  quote: { createdAt: Date } | null;
  conversation: { takeoverAt: Date | null } | null;
}

/** Exported so the rule can be tested on its own, without a database. */
export function classify(r: Classifiable): { attributed: true } | { attributed: false; reason: string } {
  if (!r.conversationId || !r.conversation) {
    return { attributed: false, reason: "Booked outside a messaging conversation, for example at the desk" };
  }

  const takeover = r.conversation.takeoverAt;
  if (!takeover) return { attributed: true };

  const quotedAt = r.quote?.createdAt ?? null;
  if (!quotedAt) {
    return { attributed: false, reason: "Your team took the conversation over before a price was given" };
  }
  if (takeover <= quotedAt) {
    return { attributed: false, reason: "Your team took the conversation over before a price was given" };
  }

  // Human joined after the quote. The engine did the work, so this counts.
  return { attributed: true };
}

/** A plain text rendering, which is what actually gets emailed with an invoice. */
export function renderReport(report: AttributionReport, businessName: string): string {
  const money = (m: Minor): string => formatMoney(m, report.totals.currency);
  const date = (d: Date): string => d.toISOString().slice(0, 10);

  const lines = [
    `Bookings handled for ${businessName}`,
    `${date(report.from)} to ${date(report.to)}`,
    "",
  ];

  for (const b of report.bookings) {
    lines.push(
      `${b.reference}  ${date(b.startAt)}  ${b.durationDays}d  ${b.vehicle} (${b.plateNumber})  ` +
        `${money(b.rentalValueMinor)}  ${b.status}`,
    );
  }

  lines.push(
    "",
    `${report.totals.bookingCount} bookings, ${money(report.totals.rentalValueMinor)} of rental revenue.`,
    `Commission at ${(report.totals.commissionBasisPoints / 100).toFixed(1)}%: ${money(report.totals.commissionMinor)}.`,
  );

  if (report.excluded.length > 0) {
    lines.push("", "Not counted:");
    for (const e of report.excluded) lines.push(`  ${e.reference}  ${e.reason}`);
  }

  return lines.join("\n");
}

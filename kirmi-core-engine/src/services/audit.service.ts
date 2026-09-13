import type { AuditActor, AuditEventType, ChannelType } from "@prisma/client";
import type { Minor } from "../core/money.js";
import type { TenantTx } from "../db/tenant-context.js";

/**
 * ===========================================================================
 * THE METRIC LEDGER
 * ===========================================================================
 *
 * Every number a client is ever shown, and every invoice Kirmi Studio ever
 * sends, is replayed from this table. Nothing is stored as a running total,
 * because a running total is an assertion and an event stream is evidence.
 *
 * Two properties matter:
 *
 *   1. Append only, enforced by a database trigger, not by good manners. A row
 *      that can be edited after the fact makes the first billing dispute
 *      unwinnable.
 *   2. Revenue and Kirmi's fee are both written at event time, computed from
 *      the terms in force at that moment. Renegotiating a client's rate must
 *      not silently rewrite last quarter.
 *
 * Writes always take the caller's transaction handle. An audit row that commits
 * while the thing it describes rolls back is worse than no audit row at all.
 */

export interface AuditEntry {
  eventType: AuditEventType;
  actor?: AuditActor;
  conversationId?: string | null;
  customerId?: string | null;
  vehicleId?: string | null;
  quoteId?: string | null;
  reservationId?: string | null;
  channel?: ChannelType | null;
  revenueMinor?: Minor | null;
  kirmiFeeMinor?: Minor | null;
  currency?: string;
  /** Set for events produced by a keyed external delivery, so a carrier replay
   *  cannot double count revenue. The unique index does the enforcing. */
  idempotencyKey?: string | null;
  payload?: Record<string, unknown>;
}

export class AuditService {
  /**
   * Record an event.
   *
   * `clientId` is passed explicitly rather than read from ambient scope: this
   * is also called from queue workers, where the ambient scope belongs to
   * whatever opened the transaction, and a ledger row stamped with the wrong
   * tenant is a billing error.
   */
  async record(tx: TenantTx, clientId: string, entry: AuditEntry): Promise<void> {
    await tx.platformAuditLog.create({
      data: {
        clientId,
        eventType: entry.eventType,
        actor: entry.actor ?? "SYSTEM",
        conversationId: entry.conversationId ?? null,
        customerId: entry.customerId ?? null,
        vehicleId: entry.vehicleId ?? null,
        quoteId: entry.quoteId ?? null,
        reservationId: entry.reservationId ?? null,
        channel: entry.channel ?? null,
        revenueMinor: entry.revenueMinor ?? null,
        kirmiFeeMinor: entry.kirmiFeeMinor ?? null,
        currency: entry.currency ?? "AED",
        idempotencyKey: entry.idempotencyKey ?? null,
        payload: (entry.payload ?? {}) as object,
      },
    });
  }

  /**
   * Record an event that must land at most once even if its producer is retried.
   *
   * The unique index on (client_id, idempotency_key) is what enforces it. A
   * second attempt hits the constraint and is swallowed, which is exactly the
   * desired outcome: the event is already recorded, so the retry succeeded.
   */
  async recordOnce(tx: TenantTx, clientId: string, entry: AuditEntry & { idempotencyKey: string }): Promise<boolean> {
    try {
      await this.record(tx, clientId, entry);
      return true;
    } catch (err) {
      if (isUniqueViolation(err)) return false;
      throw err;
    }
  }
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: string }).code === "P2002";
}

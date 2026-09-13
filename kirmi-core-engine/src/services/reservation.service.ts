import type { Reservation } from "@prisma/client";
import { PG_EXCLUSION_VIOLATION, PG_LOCK_NOT_AVAILABLE } from "../config/constants.js";
import { assessAvailability, explainVerdict } from "../core/availability/availability.engine.js";
import { NotFoundError, VehicleContendedError, VehicleUnavailableError, pgErrorCode } from "../core/errors.js";
import { bookingReference } from "../core/ids.js";
import type { Logger } from "../core/logger.js";
import { calculateKirmiFee } from "../core/pricing/pricing.engine.js";
import { minutesFromNow, rentalDays } from "../core/time.js";
import type { TenantProfile } from "../core/types.js";
import type { TenantDatabase, TenantTx } from "../db/tenant-context.js";
import type { AuditService } from "./audit.service.js";
import type { VehicleService } from "./vehicle.service.js";

/**
 * ===========================================================================
 * THE RESERVATION LOOP AND ITS INVENTORY LOCK
 * ===========================================================================
 *
 * The failure this file exists to prevent:
 *
 *   Two customers message about the same Lamborghini for the same weekend,
 *   90 milliseconds apart. Both requests check availability, both see a free
 *   car because neither has written yet, both write a hold. Two customers now
 *   have a confirmation for one car. The client finds out on Friday, at the
 *   airport, in front of one of them.
 *
 * The fix is a pessimistic row lock, taken before the availability check and
 * held until commit:
 *
 *   SELECT id FROM vehicles WHERE id = $1 FOR UPDATE NOWAIT
 *
 * FOR UPDATE serialises the two requests: the second cannot read that row
 * until the first commits or rolls back, so its availability check runs against
 * the truth rather than against a stale snapshot.
 *
 * NOWAIT decides how the loser finds out. Without it the second request blocks
 * until the first finishes, which under contention stacks requests up behind
 * each other and burns the reply SLA. With it, Postgres raises 55P03
 * immediately and the loser gets a clean, fast rejection it can turn into
 * "that one has just gone, the Huracan is free those dates" while the customer
 * is still typing.
 *
 * Losing this race is a normal outcome, not an error. The contended customer is
 * still a customer, and the whole point of answering in seconds is to offer
 * them the next car before they go elsewhere.
 *
 * Behind all of this sits the exclusion constraint from migration 0002, which
 * makes an overlapping active reservation unrepresentable even if some future
 * code path forgets to take the lock at all.
 */

export interface CreateHoldParams {
  tenant: TenantProfile;
  vehicleId: string;
  customerId: string;
  quoteId?: string | null;
  conversationId?: string | null;
  startAt: Date;
  endAt: Date;
  totalMinor: number;
  vatMinor: number;
  depositMinor: number;
  deliveryRequired?: boolean;
  deliveryAddress?: string | null;
}

export class ReservationService {
  constructor(
    private readonly db: TenantDatabase,
    private readonly vehicles: VehicleService,
    private readonly audit: AuditService,
    private readonly log: Logger,
  ) {}

  /**
   * Place a hold on a specific vehicle for a specific window.
   *
   * The entire sequence runs in one transaction. Lock, verify, write, audit,
   * commit. If any step fails, the lock is released by the rollback and the car
   * is immediately sellable again rather than stranded.
   */
  async createHold(params: CreateHoldParams): Promise<Reservation> {
    const { tenant, vehicleId, startAt, endAt } = params;
    const durationDays = rentalDays(startAt, endAt);

    return this.db.withTenant(
      tenant.clientId,
      async (tx) => {
        // --- 1. Take the lock, before reading anything we intend to act on ---
        await this.lockVehicleRow(tx, vehicleId);

        // --- 2. Now read. Nothing can change this vehicle until we commit ---
        const vehicle = await this.vehicles.getSnapshot(tx, vehicleId);
        const claims = await this.vehicles.claimsFor(tx, vehicleId, startAt, endAt);

        const verdict = assessAvailability(vehicle, claims, { startAt, endAt }, new Date());
        if (!verdict.available) {
          // Thrown, not audited here. Writing the rejection inside this
          // transaction would roll it back along with the failed hold, and the
          // ledger would quietly lose every record of demand for cars the
          // client had nothing free for. That is a fleet purchasing signal, so
          // it is recorded below, in its own transaction, after the rollback.
          throw new VehicleUnavailableError(explainVerdict(verdict, vehicle), {
            vehicleId,
            reasons: verdict.reasons,
            conflicts: verdict.conflicts.map((c) => ({ from: c.startAt.toISOString(), to: c.endAt.toISOString() })),
          });
        }

        // --- 3. Write the claim ---
        const reservation = await tx.reservation.create({
          data: {
            clientId: tenant.clientId,
            quoteId: params.quoteId ?? null,
            conversationId: params.conversationId ?? null,
            customerId: params.customerId,
            vehicleId,
            reference: bookingReference(tenant.slug),
            status: "HOLD",
            startAt,
            endAt,
            durationDays,
            // A hold with no expiry is a car withdrawn from sale forever. The
            // TTL is per client, because a desk that answers in 30 seconds can
            // afford a shorter one than a desk that answers in the morning.
            holdExpiresAt: minutesFromNow(tenant.pricing.holdTtlMinutes),
            deliveryRequired: params.deliveryRequired ?? false,
            deliveryAddress: params.deliveryAddress ?? null,
            totalMinor: params.totalMinor,
            vatMinor: params.vatMinor,
            depositMinor: params.depositMinor,
            currency: tenant.currency,
          },
        });

        await this.audit.record(tx, tenant.clientId, {
          eventType: "HOLD_CREATED",
          vehicleId,
          customerId: params.customerId,
          conversationId: params.conversationId ?? null,
          quoteId: params.quoteId ?? null,
          reservationId: reservation.id,
          payload: {
            reference: reservation.reference,
            holdExpiresAt: reservation.holdExpiresAt?.toISOString(),
            totalMinor: params.totalMinor,
          },
        });

        return reservation;
      },
      // Longer than the default: this transaction holds a row lock, and a
      // timeout mid-hold would leave the customer with no answer either way.
      { timeoutMs: 15_000 },
    ).catch(async (err: unknown) => {
      // The rejection is recorded here, outside the rolled back transaction,
      // and only for a settled unavailability. Contention is not recorded: it
      // is a lost millisecond race, not evidence that the fleet is short.
      if (err instanceof VehicleUnavailableError) {
        await this.recordRejection(tenant.clientId, {
          vehicleId,
          customerId: params.customerId,
          conversationId: params.conversationId ?? null,
          reasons: (err.details["reasons"] as string[] | undefined) ?? [],
          startAt,
          endAt,
        });
      }
      throw err;
    });
  }

  /**
   * Log a refused hold. Best effort on purpose: the customer already has their
   * answer, and a ledger write failing here must not turn a clean "that one is
   * taken" into a 500.
   */
  private async recordRejection(
    clientId: string,
    detail: {
      vehicleId: string;
      customerId: string;
      conversationId: string | null;
      reasons: string[];
      startAt: Date;
      endAt: Date;
    },
  ): Promise<void> {
    try {
      await this.db.withTenant(clientId, async (tx) => {
        await this.audit.record(tx, clientId, {
          eventType: "HOLD_REJECTED",
          vehicleId: detail.vehicleId,
          customerId: detail.customerId,
          conversationId: detail.conversationId,
          payload: {
            reasons: detail.reasons,
            startAt: detail.startAt.toISOString(),
            endAt: detail.endAt.toISOString(),
          },
        });
      });
    } catch (err) {
      this.log.error({ err, clientId, vehicleId: detail.vehicleId }, "could not record a refused hold");
    }
  }

  /**
   * SELECT ... FOR UPDATE NOWAIT on the vehicle row.
   *
   * Raw SQL because there is no Prisma API for row locks, and because the exact
   * lock semantics are the point rather than an implementation detail.
   *
   * No clientId predicate is needed: row level security has already narrowed
   * `vehicles` to this tenant, so a vehicle id belonging to another client
   * simply does not exist from inside this transaction.
   */
  private async lockVehicleRow(tx: TenantTx, vehicleId: string): Promise<void> {
    try {
      const locked = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM vehicles WHERE id = ${vehicleId}::uuid FOR UPDATE NOWAIT
      `;
      if (locked.length === 0) {
        throw new NotFoundError("Vehicle not found", { vehicleId });
      }
    } catch (err) {
      if (err instanceof NotFoundError) throw err;

      const code = pgErrorCode(err);
      if (code === PG_LOCK_NOT_AVAILABLE) {
        // Someone else is mid-booking on this exact car, right now. Fast, clean
        // rejection so the caller can offer an alternative immediately.
        this.log.info({ vehicleId }, "vehicle row contended, rejecting concurrent hold");
        throw new VehicleContendedError("Someone else is booking this car right now", { vehicleId });
      }
      throw err;
    }
  }

  /**
   * Turn a hold into a booking.
   *
   * This is where revenue enters the ledger, and where Kirmi's fee is computed
   * from the terms in force at this moment rather than at invoice time.
   */
  async confirm(
    tenant: TenantProfile,
    reservationId: string,
    payment: { provider?: string; reference?: string; paidMinor: number },
  ): Promise<Reservation> {
    return this.db.withTenant(tenant.clientId, async (tx) => {
      const existing = await tx.reservation.findUnique({ where: { id: reservationId } });
      if (!existing) throw new NotFoundError("Reservation not found", { reservationId });

      if (existing.status === "CONFIRMED") {
        // Idempotent by design: a repeated payment callback must not book twice
        // or attribute the revenue twice.
        return existing;
      }
      if (existing.status !== "HOLD") {
        throw new VehicleUnavailableError("This booking is no longer open", {
          reservationId,
          status: existing.status,
        });
      }
      if (existing.holdExpiresAt && existing.holdExpiresAt.getTime() < Date.now()) {
        throw new VehicleUnavailableError("That hold has expired, the car may have been taken", { reservationId });
      }

      const reservation = await tx.reservation.update({
        where: { id: reservationId },
        data: {
          status: "CONFIRMED",
          confirmedAt: new Date(),
          holdExpiresAt: null,
          paidMinor: payment.paidMinor,
          paymentProvider: payment.provider ?? null,
          paymentReference: payment.reference ?? null,
        },
      });

      const kirmiFeeMinor = calculateKirmiFee(reservation.totalMinor, tenant.billing);

      await this.audit.record(tx, tenant.clientId, {
        eventType: "BOOKING_SECURED",
        vehicleId: reservation.vehicleId,
        customerId: reservation.customerId,
        conversationId: reservation.conversationId,
        quoteId: reservation.quoteId,
        reservationId: reservation.id,
        revenueMinor: reservation.totalMinor,
        kirmiFeeMinor,
        currency: reservation.currency,
        // Keyed on the payment reference so a gateway retry cannot count the
        // same booking twice on the client's invoice.
        idempotencyKey: payment.reference ? `booking:${payment.reference}` : `booking:${reservation.id}`,
        payload: {
          reference: reservation.reference,
          feeModel: tenant.billing.feeModel,
          commissionBasisPoints: tenant.billing.commissionBasisPoints,
        },
      });

      return reservation;
    });
  }

  async cancel(tenant: TenantProfile, reservationId: string, reason: string): Promise<Reservation> {
    return this.db.withTenant(tenant.clientId, async (tx) => {
      const existing = await tx.reservation.findUnique({ where: { id: reservationId } });
      if (!existing) throw new NotFoundError("Reservation not found", { reservationId });

      const reservation = await tx.reservation.update({
        where: { id: reservationId },
        data: { status: "CANCELLED", cancelledAt: new Date(), cancellationReason: reason, holdExpiresAt: null },
      });

      await this.audit.record(tx, tenant.clientId, {
        eventType: "BOOKING_CANCELLED",
        vehicleId: reservation.vehicleId,
        customerId: reservation.customerId,
        reservationId: reservation.id,
        // Negative revenue would corrupt SUM(). A cancellation is its own event
        // and the metrics service nets it off explicitly.
        payload: { reason, previousStatus: existing.status, releasedMinor: reservation.totalMinor },
      });

      return reservation;
    });
  }

  /**
   * Release holds nobody completed.
   *
   * Runs every minute. An expired hold that is not swept is a car that cannot
   * be sold to anyone, which makes this unglamorous job one of the most
   * directly revenue affecting things in the system.
   */
  async sweepExpiredHolds(clientId: string, now: Date = new Date()): Promise<number> {
    return this.db.withTenant(clientId, async (tx) => {
      const expired = await tx.reservation.findMany({
        where: { status: "HOLD", holdExpiresAt: { lt: now } },
        select: { id: true, vehicleId: true, customerId: true, reference: true },
      });
      if (expired.length === 0) return 0;

      await tx.reservation.updateMany({
        where: { id: { in: expired.map((r) => r.id) } },
        data: { status: "EXPIRED", holdExpiresAt: null },
      });

      for (const row of expired) {
        await this.audit.record(tx, clientId, {
          eventType: "HOLD_EXPIRED",
          vehicleId: row.vehicleId,
          customerId: row.customerId,
          reservationId: row.id,
          payload: { reference: row.reference },
        });
      }

      this.log.info({ clientId, released: expired.length }, "expired holds released");
      return expired.length;
    });
  }
}

/** Exported for the integration test that asserts the constraint backstop fires. */
export function isOverlapViolation(err: unknown): boolean {
  return pgErrorCode(err) === PG_EXCLUSION_VIOLATION;
}

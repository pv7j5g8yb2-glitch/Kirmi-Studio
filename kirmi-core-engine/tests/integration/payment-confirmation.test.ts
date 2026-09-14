import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { AttributionService, classify } from "../../src/services/attribution.service.js";
import { AuditService } from "../../src/services/audit.service.js";
import { ReservationService } from "../../src/services/reservation.service.js";
import { VehicleService } from "../../src/services/vehicle.service.js";
import { logger } from "../../src/core/logger.js";
import { minutesFromNow } from "../../src/core/time.js";
import { tenantDatabase, withTenant } from "../../src/db/tenant-context.js";
import { tenantFixture } from "../helpers/fixtures.js";
import {
  closeHarness,
  databaseAvailable,
  futureWindow,
  resetDatabase,
  seedTenant,
  type SeededTenant,
} from "../helpers/database.js";

/**
 * The money path: hold, payment, booking, invoice.
 *
 * This suite exists because of a bug that cost nothing to write and would have
 * cost real money every night. A hold lives for thirty minutes. A customer who
 * agrees at 11pm and pays at 11.40pm would have found their reservation already
 * swept to EXPIRED, and because the commission report only counts HOLD,
 * CONFIRMED and COMPLETED, a booking genuinely won and genuinely paid for would
 * have been invoiced as nothing at all. No error, no alert, just a smaller
 * number at the end of the month.
 */

const available = await databaseAvailable();

describe.skipIf(!available)("payment confirmation", () => {
  let tenant: SeededTenant;
  let reservations: ReservationService;
  let attribution: AttributionService;
  const profile = tenantFixture();

  beforeEach(async () => {
    await resetDatabase();
    tenant = await seedTenant(`pay-${Date.now()}`);
    const audit = new AuditService();
    reservations = new ReservationService(tenantDatabase, new VehicleService(), audit, logger());
    attribution = new AttributionService(tenantDatabase, logger());
  });

  afterAll(async () => {
    await closeHarness();
  });

  /**
   * A hold as the engine really makes one: out of a conversation.
   *
   * Attribution deliberately refuses a reservation with no conversation,
   * because that is a walk in and belongs to the client. Building the test
   * without one produced a confirmed, paid booking that still invoiced as
   * nothing, which is the rule working rather than failing.
   */
  async function placeHold(holdMinutes: number): Promise<string> {
    const window = futureWindow(3);
    const conversationId = await withTenant(tenant.clientId, async (tx) => {
      const conversation = await tx.conversation.create({
        data: {
          clientId: tenant.clientId,
          customerId: tenant.customerId,
          channel: "WHATSAPP",
          state: "QUALIFIED",
          lastInboundAt: new Date(),
        },
      });
      return conversation.id;
    });

    const reservation = await reservations.createHold({
      tenant: { ...profile, clientId: tenant.clientId, pricing: { ...profile.pricing, holdTtlMinutes: holdMinutes } },
      vehicleId: tenant.vehicleId,
      customerId: tenant.customerId,
      conversationId,
      quoteId: null,
      startAt: window.startAt,
      endAt: window.endAt,
      totalMinor: 1_575_000,
      vatMinor: 75_000,
      depositMinor: 500_000,
      deliveryRequired: false,
    });
    return reservation.id;
  }

  it("turns a hold into a confirmed booking when the payment lands", async () => {
    const id = await placeHold(240);
    const confirmed = await reservations.confirm({ ...profile, clientId: tenant.clientId }, id, {
      provider: "stripe",
      reference: "pi_test_123",
      paidMinor: 1_575_000,
    });

    expect(confirmed.status).toBe("CONFIRMED");
    expect(confirmed.paidMinor).toBe(1_575_000);
    expect(confirmed.confirmedAt).not.toBeNull();
    // Cleared, so the sweeper can never touch a paid booking.
    expect(confirmed.holdExpiresAt).toBeNull();
  });

  it("is idempotent, so a retried Stripe callback cannot book or bill twice", async () => {
    const id = await placeHold(240);
    const profileFor = { ...profile, clientId: tenant.clientId };
    const first = await reservations.confirm(profileFor, id, { provider: "stripe", reference: "pi_1", paidMinor: 1_575_000 });
    const second = await reservations.confirm(profileFor, id, { provider: "stripe", reference: "pi_1", paidMinor: 1_575_000 });

    expect(second.id).toBe(first.id);
    expect(second.confirmedAt?.toISOString()).toBe(first.confirmedAt?.toISOString());

    const bookings = await withTenant(tenant.clientId, async (tx) =>
      tx.platformAuditLog.count({ where: { clientId: tenant.clientId, eventType: "BOOKING_SECURED" } }),
    );
    expect(bookings).toBe(1);
  });

  it("refuses to confirm a hold the sweeper already released", async () => {
    const id = await placeHold(240);
    await withTenant(tenant.clientId, async (tx) => {
      await tx.reservation.update({ where: { id }, data: { holdExpiresAt: minutesFromNow(-5) } });
    });
    const released = await reservations.sweepExpiredHolds(tenant.clientId);
    expect(released).toBe(1);

    await expect(
      reservations.confirm({ ...profile, clientId: tenant.clientId }, id, {
        provider: "stripe",
        reference: "pi_late",
        paidMinor: 1_575_000,
      }),
    ).rejects.toThrow();
  });

  it("THE BUG: a 30 minute hold loses the booking from the commission report", async () => {
    // Exactly the 11pm case. Hold placed, payment link sent, customer pays
    // forty minutes later, sweeper has already been round.
    const id = await placeHold(30);
    await withTenant(tenant.clientId, async (tx) => {
      await tx.reservation.update({ where: { id }, data: { holdExpiresAt: minutesFromNow(-10) } });
    });
    await reservations.sweepExpiredHolds(tenant.clientId);

    const report = await attribution.report(
      tenant.clientId,
      new Date(Date.now() - 60 * 60 * 1000),
      new Date(Date.now() + 60 * 60 * 1000),
      1_000,
    );

    expect(report.totals.bookingCount).toBe(0);
    expect(report.totals.commissionMinor).toBe(0);
  });

  it("THE FIX: the payment window keeps it alive and on the invoice", async () => {
    const id = await placeHold(240);
    await reservations.sweepExpiredHolds(tenant.clientId);

    await reservations.confirm({ ...profile, clientId: tenant.clientId }, id, {
      provider: "stripe",
      reference: "pi_ok",
      paidMinor: 1_575_000,
    });

    const report = await attribution.report(
      tenant.clientId,
      new Date(Date.now() - 60 * 60 * 1000),
      new Date(Date.now() + 60 * 60 * 1000),
      1_000,
    );

    expect(report.totals.bookingCount).toBe(1);
    // Commission is charged on the rental, never on the VAT.
    expect(report.totals.rentalValueMinor).toBe(1_575_000 - 75_000);
    expect(report.totals.commissionMinor).toBe(150_000);
  });

  it("counts a walk in booking as the client's, not ours", () => {
    expect(classify({ conversationId: null, quote: null, conversation: null }).attributed).toBe(false);
  });
});

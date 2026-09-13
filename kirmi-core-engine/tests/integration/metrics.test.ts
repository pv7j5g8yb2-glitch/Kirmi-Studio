import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { disconnectRedis } from "../../src/cache/redis.js";
import { buildContainer, type Container } from "../../src/core/container.js";
import type { TenantProfile } from "../../src/core/types.js";
import { prisma } from "../../src/db/prisma.js";
import { withTenant } from "../../src/db/tenant-context.js";
import {
  closeHarness,
  databaseAvailable,
  futureWindow,
  migrate,
  resetDatabase,
  seedTenant,
  type SeededTenant,
} from "../helpers/database.js";

/**
 * ===========================================================================
 * THE FOUR METRIC CHANNELS
 * ===========================================================================
 *
 * These are the numbers a client sees on their dashboard and the numbers Kirmi
 * Studio invoices against, which makes them the numbers most worth being
 * paranoid about. All four are replayed from the ledger rather than kept as
 * running totals, so the dashboard and the invoice cannot drift apart.
 *
 * The test that matters most is the last one: a cancelled booking must not
 * quietly stay in the revenue figure, and must not be silently erased from it
 * either. Gross, cancelled and net are reported separately because one number
 * cannot honestly say all three.
 */

const available = await databaseAvailable();

describe.skipIf(!available)("metrics", () => {
  let tenant: SeededTenant;
  let rival: SeededTenant;
  let container: Container;
  let profile: TenantProfile;

  beforeAll(() => {
    migrate();
  });

  beforeEach(async () => {
    await resetDatabase();
    tenant = await seedTenant("metrics");
    rival = await seedTenant("rival");

    container = buildContainer();
    await container.config.invalidate(tenant.clientId);
    profile = await container.config.loadProfile(tenant.clientId);
  });

  afterAll(async () => {
    await resetDatabase();
    await prisma().$disconnect();
    await disconnectRedis();
    await closeHarness();
  });

  // One whole calendar month, which is the window an invoice is actually cut
  // for. The retainer prorates per month, so a whole month is the case that has
  // to reconcile exactly.
  const now = new Date();
  const window = {
    from: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)),
    to: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)),
  };

  async function secureABooking(totalMinor: number): Promise<string> {
    const reservation = await container.reservations.createHold({
      tenant: profile,
      vehicleId: tenant.vehicleId,
      customerId: tenant.customerId,
      startAt: futureWindow(2).startAt,
      endAt: futureWindow(2).endAt,
      totalMinor,
      vatMinor: Math.round((totalMinor / 21) * 1),
      depositMinor: 500_000,
    });
    await container.reservations.confirm(profile, reservation.id, { paidMinor: totalMinor, reference: `pay-${reservation.id}` });
    return reservation.id;
  }

  it("reports all four channels", async () => {
    await withTenant(tenant.clientId, async (tx) => {
      await container.audit.record(tx, tenant.clientId, { eventType: "ENQUIRY_RECEIVED", channel: "WHATSAPP" });
      await container.audit.record(tx, tenant.clientId, { eventType: "ENQUIRY_RECEIVED", channel: "INSTAGRAM" });
    });
    await secureABooking(1_000_000);

    const snapshot = await container.metrics.snapshot(profile, window);

    expect(snapshot.enquiriesReceived).toBe(2);
    expect(snapshot.bookingsSecured).toBe(1);
    expect(snapshot.revenue.grossMinor).toBe(1_000_000);
    // HYBRID: 5% commission on the booking, plus exactly one month's retainer
    // for a window that is exactly one month.
    expect(snapshot.kirmiFee.commissionMinor).toBe(50_000);
    expect(snapshot.kirmiFee.retainerMinor).toBe(800_000);
    expect(snapshot.kirmiFee.totalMinor).toBe(850_000);
  });

  it("never shows one client another client's numbers", async () => {
    // The isolation guarantee applied to the figure that would hurt most.
    await withTenant(rival.clientId, async (tx) => {
      await container.audit.record(tx, rival.clientId, {
        eventType: "BOOKING_SECURED",
        revenueMinor: 99_000_000,
        kirmiFeeMinor: 4_950_000,
      });
    });

    const snapshot = await container.metrics.snapshot(profile, window);
    expect(snapshot.bookingsSecured).toBe(0);
    expect(snapshot.revenue.grossMinor).toBe(0);
    expect(snapshot.kirmiFee.commissionMinor).toBe(0);
  });

  it("does not double count a payment callback that arrives twice", async () => {
    // Gateways retry. Counting the retry would inflate the client's revenue and
    // Kirmi's own invoice at the same time, which is the worst possible pair of
    // errors to make together.
    const reservation = await container.reservations.createHold({
      tenant: profile,
      vehicleId: tenant.vehicleId,
      customerId: tenant.customerId,
      ...futureWindow(2),
      totalMinor: 2_000_000,
      vatMinor: 95_238,
      depositMinor: 500_000,
    });

    await container.reservations.confirm(profile, reservation.id, { paidMinor: 2_000_000, reference: "pay-retry-1" });
    await container.reservations.confirm(profile, reservation.id, { paidMinor: 2_000_000, reference: "pay-retry-1" });

    const snapshot = await container.metrics.snapshot(profile, window);
    expect(snapshot.bookingsSecured).toBe(1);
    expect(snapshot.revenue.grossMinor).toBe(2_000_000);
  });

  it("reports gross, cancelled and net separately rather than one misleading figure", async () => {
    const keptId = await secureABooking(1_000_000);
    expect(keptId).toBeTruthy();

    const cancelled = await container.reservations.createHold({
      tenant: profile,
      vehicleId: tenant.secondVehicleId,
      customerId: tenant.customerId,
      ...futureWindow(2),
      totalMinor: 400_000,
      vatMinor: 19_048,
      depositMinor: 200_000,
    });
    await container.reservations.confirm(profile, cancelled.id, { paidMinor: 400_000, reference: "pay-cancelled" });
    await container.reservations.cancel(profile, cancelled.id, "Customer changed plans");

    const snapshot = await container.metrics.snapshot(profile, window);

    // The engine did convert both. The client's cash only arrived for one.
    expect(snapshot.revenue.grossMinor).toBe(1_400_000);
    expect(snapshot.revenue.cancelledMinor).toBe(400_000);
    expect(snapshot.revenue.netMinor).toBe(1_000_000);
  });

  it("computes the fee from the terms in force when the booking happened", async () => {
    await secureABooking(1_000_000);

    // Renegotiate the commission afterwards.
    await withTenant(tenant.clientId, async (tx) => {
      await tx.clientConfiguration.update({ where: { clientId: tenant.clientId }, data: { commissionBasisPoints: 2_000 } });
    });
    await container.config.invalidate(tenant.clientId);
    const renegotiated = await container.config.loadProfile(tenant.clientId);

    const snapshot = await container.metrics.snapshot(renegotiated, window);
    // Still 5%, because that is what was owed at the time. A new rate must not
    // silently rewrite last quarter's invoices.
    expect(snapshot.kirmiFee.commissionMinor).toBe(50_000);
  });

  it("buckets the daily series in the client's own timezone", async () => {
    await withTenant(tenant.clientId, async (tx) => {
      await container.audit.record(tx, tenant.clientId, { eventType: "ENQUIRY_RECEIVED", channel: "WHATSAPP" });
    });

    const points = await container.metrics.daily(profile, window);
    expect(points.length).toBeGreaterThan(0);
    expect(points.some((p) => p.enquiries > 0)).toBe(true);
    expect(points[0]?.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("refuses to let the ledger be rewritten after the fact", async () => {
    // Enforced by a database trigger, not by convention. If an invoice can be
    // edited after it is issued it is an assertion, not evidence.
    await secureABooking(1_000_000);

    await expect(
      withTenant(tenant.clientId, async (tx) =>
        tx.$executeRawUnsafe(`UPDATE platform_audit_logs SET revenue_minor = 1 WHERE client_id = '${tenant.clientId}'`),
      ),
    ).rejects.toThrow();

    await expect(
      withTenant(tenant.clientId, async (tx) =>
        tx.$executeRawUnsafe(`DELETE FROM platform_audit_logs WHERE client_id = '${tenant.clientId}'`),
      ),
    ).rejects.toThrow();

    const snapshot = await container.metrics.snapshot(profile, window);
    expect(snapshot.revenue.grossMinor).toBe(1_000_000);
  });
});

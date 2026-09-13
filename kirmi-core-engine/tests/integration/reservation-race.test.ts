import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { VehicleContendedError, VehicleUnavailableError } from "../../src/core/errors.js";
import { logger } from "../../src/core/logger.js";
import { prisma } from "../../src/db/prisma.js";
import { tenantDatabase, withTenant } from "../../src/db/tenant-context.js";
import { AuditService } from "../../src/services/audit.service.js";
import { ClientConfigService } from "../../src/services/client-config.service.js";
import { ReservationService } from "../../src/services/reservation.service.js";
import { VehicleService } from "../../src/services/vehicle.service.js";
import { createContextCache } from "../../src/cache/conversation-context.cache.js";
import type { TenantProfile } from "../../src/core/types.js";
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
 * THE DOUBLE BOOKING RACE
 * ===========================================================================
 *
 * The scenario: two customers message about the same Lamborghini for the same
 * weekend, milliseconds apart. Both requests check availability, both see a
 * free car because neither has written yet, and both write a hold. The client
 * discovers it on Friday, at the airport, in front of one of them.
 *
 * These tests run genuinely concurrent transactions against a real PostgreSQL.
 * The guarantee is a property of SELECT ... FOR UPDATE NOWAIT and of the
 * exclusion constraint, so nothing here is mocked: a mock would only prove that
 * the mock agrees with itself.
 *
 * What is asserted, in order of how much it matters:
 *
 *   1. Exactly one of N simultaneous attempts succeeds. Never two.
 *   2. The losers fail FAST, with a clean code, rather than queueing behind the
 *      winner and burning the reply budget.
 *   3. Even if the lock were bypassed entirely, the database still refuses.
 */

const available = await databaseAvailable();

describe.skipIf(!available)("inventory locking under concurrency", () => {
  let tenant: SeededTenant;
  let profile: TenantProfile;
  let reservations: ReservationService;

  beforeAll(() => {
    migrate();
  });

  beforeEach(async () => {
    await resetDatabase();
    tenant = await seedTenant("race");

    const config = new ClientConfigService(tenantDatabase, createContextCache(), logger());
    await config.invalidate(tenant.clientId);
    profile = await config.loadProfile(tenant.clientId);

    reservations = new ReservationService(tenantDatabase, new VehicleService(), new AuditService(), logger());
  });

  afterAll(async () => {
    await resetDatabase();
    await prisma().$disconnect();
    await closeHarness();
  });

  const hold = (window: { startAt: Date; endAt: Date }) =>
    reservations.createHold({
      tenant: profile,
      vehicleId: tenant.vehicleId,
      customerId: tenant.customerId,
      startAt: window.startAt,
      endAt: window.endAt,
      totalMinor: 945_000,
      vatMinor: 45_000,
      depositMinor: 1_000_000,
    });

  it("lets a single uncontended hold through", async () => {
    const reservation = await hold(futureWindow(3));
    expect(reservation.status).toBe("HOLD");
    expect(reservation.reference).toMatch(/^RACE-[A-Z0-9]{6}$/);
    expect(reservation.holdExpiresAt).toBeInstanceOf(Date);
  });

  it("rejects a second attempt immediately while the row is locked, rather than queueing", async () => {
    // Deterministic contention: hold the vehicle row in one transaction and
    // attempt a hold from another while that lock is live. This is the exact
    // moment the NOWAIT clause exists for.
    const window = futureWindow(3);

    let releaseLock: () => void = () => undefined;
    const lockHeld = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });

    const locker = withTenant(
      tenant.clientId,
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM vehicles WHERE id = ${tenant.vehicleId}::uuid FOR UPDATE`;
        await lockHeld;
        return "released";
      },
      { timeoutMs: 20_000 },
    );

    // Give the locking transaction a moment to actually take the lock.
    await new Promise((resolve) => setTimeout(resolve, 150));

    const startedAt = Date.now();
    await expect(hold(window)).rejects.toBeInstanceOf(VehicleContendedError);
    const elapsed = Date.now() - startedAt;

    // The point of NOWAIT: the loser finds out in milliseconds and can offer
    // an alternative while the customer is still typing, instead of blocking.
    expect(elapsed).toBeLessThan(2_000);

    releaseLock();
    await locker;
  });

  it("allows exactly one of eight simultaneous attempts to win", async () => {
    const window = futureWindow(3);

    const outcomes = await Promise.allSettled(Array.from({ length: 8 }, () => hold(window)));
    const fulfilled = outcomes.filter((o) => o.status === "fulfilled");
    const rejected = outcomes.filter((o) => o.status === "rejected");

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(7);

    // Every loser failed for a reason we can explain to a customer: either the
    // row was contended at that instant, or by the time they got the lock the
    // car was genuinely taken.
    for (const outcome of rejected) {
      const reason = (outcome as PromiseRejectedResult).reason;
      expect(
        reason instanceof VehicleContendedError || reason instanceof VehicleUnavailableError,
        `unexpected rejection: ${String(reason)}`,
      ).toBe(true);
    }

    // And the database agrees: one live claim on that car, not eight.
    const live = await withTenant(tenant.clientId, async (tx) =>
      tx.reservation.count({ where: { vehicleId: tenant.vehicleId, status: { in: ["HOLD", "CONFIRMED"] } } }),
    );
    expect(live).toBe(1);
  });

  it("does not serialise holds on different cars", async () => {
    // The lock is per vehicle row. Two customers booking two different cars
    // must not block each other, or a busy Friday becomes a queue.
    const window = futureWindow(3);

    const [first, second] = await Promise.all([
      hold(window),
      reservations.createHold({
        tenant: profile,
        vehicleId: tenant.secondVehicleId,
        customerId: tenant.customerId,
        startAt: window.startAt,
        endAt: window.endAt,
        totalMinor: 598_500,
        vatMinor: 28_500,
        depositMinor: 500_000,
      }),
    ]);

    expect(first.status).toBe("HOLD");
    expect(second.status).toBe("HOLD");
  });

  it("allows a back to back hire: return at 10:00, collect at 10:00", async () => {
    const first = futureWindow(3);
    const second = { startAt: first.endAt, endAt: new Date(first.endAt.getTime() + 2 * 24 * 3_600_000) };

    await hold(first);
    const next = await hold(second);
    expect(next.status).toBe("HOLD");
  });

  it("refuses a hold that overlaps an existing one, even sequentially", async () => {
    const first = futureWindow(5);
    await hold(first);

    const overlapping = {
      startAt: new Date(first.startAt.getTime() + 24 * 3_600_000),
      endAt: new Date(first.endAt.getTime() + 24 * 3_600_000),
    };
    await expect(hold(overlapping)).rejects.toBeInstanceOf(VehicleUnavailableError);
  });

  it("frees the car again once a hold expires and the sweeper runs", async () => {
    const window = futureWindow(3);
    const reservation = await hold(window);

    // Age the hold past its expiry, the way a customer who wandered off would.
    // Through a tenant scope, because the owner role is FORCE RLS confined too:
    // an unscoped UPDATE here would silently affect zero rows and the test
    // would be asserting against a hold that never actually expired.
    await withTenant(tenant.clientId, async (tx) => {
      await tx.reservation.update({
        where: { id: reservation.id },
        data: { holdExpiresAt: new Date(Date.now() - 60_000) },
      });
    });

    const released = await reservations.sweepExpiredHolds(tenant.clientId);
    expect(released).toBe(1);

    // And the car is sellable again, which is the entire point of sweeping.
    const next = await hold(window);
    expect(next.status).toBe("HOLD");
  });

  it("still refuses an overlapping write if the row lock is bypassed entirely", async () => {
    // The backstop from migration 0002. Even a future code path that forgets to
    // take the lock cannot represent two live claims on one car.
    const window = futureWindow(3);
    const reservation = await hold(window);

    await expect(
      withTenant(tenant.clientId, async (tx) =>
        tx.$executeRawUnsafe(`
          INSERT INTO reservations (id, client_id, customer_id, vehicle_id, reference, status,
                                    start_at, end_at, duration_days, hold_expires_at,
                                    total_minor, deposit_minor, currency, updated_at)
          VALUES (gen_random_uuid(), '${tenant.clientId}', '${tenant.customerId}', '${tenant.vehicleId}',
                  'RACE-BYPASS', 'HOLD',
                  '${window.startAt.toISOString()}', '${window.endAt.toISOString()}', 3,
                  now() + interval '30 minutes', 945000, 1000000, 'AED', now())
        `),
      ),
    ).rejects.toThrow();

    const live = await withTenant(tenant.clientId, async (tx) =>
      tx.reservation.count({ where: { vehicleId: tenant.vehicleId, status: { in: ["HOLD", "CONFIRMED"] } } }),
    );
    expect(live).toBe(1);
    expect(reservation.status).toBe("HOLD");
  });

  it("records the winner and the rejections in the ledger", async () => {
    const window = futureWindow(3);
    await hold(window);
    await expect(hold(window)).rejects.toThrow();

    const events = await withTenant(tenant.clientId, async (tx) =>
      tx.platformAuditLog.findMany({ orderBy: { id: "asc" } }),
    );

    expect(events.map((e) => e.eventType)).toEqual(expect.arrayContaining(["HOLD_CREATED", "HOLD_REJECTED"]));
  });
});

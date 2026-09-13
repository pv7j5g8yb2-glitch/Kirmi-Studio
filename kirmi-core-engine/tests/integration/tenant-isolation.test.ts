import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../../src/db/prisma.js";
import { withTenant } from "../../src/db/tenant-context.js";
import { TenantResolutionError } from "../../src/core/errors.js";
import {
  closeHarness,
  databaseAvailable,
  migrate,
  ownerClient,
  resetDatabase,
  seedTenant,
  type SeededTenant,
} from "../helpers/database.js";

/**
 * ===========================================================================
 * TENANT ISOLATION, PROVED AGAINST A REAL DATABASE
 * ===========================================================================
 *
 * The claim under test: client A can never read, write, count or otherwise
 * observe client B's data, and this holds even when the application code is
 * wrong. That last clause is why these tests run against a real PostgreSQL with
 * the real policies applied. Row level security is a database feature; a mock
 * proves nothing about it.
 *
 * Several of these tests deliberately write queries with no clientId filter at
 * all, of the kind a tired engineer produces on a Friday. They are supposed to
 * return nothing, and the reason they return nothing is Postgres, not Prisma.
 */

const available = await databaseAvailable();

describe.skipIf(!available)("tenant isolation", () => {
  let alpha: SeededTenant;
  let bravo: SeededTenant;

  beforeAll(() => {
    migrate();
  });

  beforeEach(async () => {
    await resetDatabase();
    alpha = await seedTenant("alpha");
    bravo = await seedTenant("bravo");
  });

  afterAll(async () => {
    await resetDatabase();
    await prisma().$disconnect();
    await closeHarness();
  });

  it("shows a tenant only its own fleet, from an unfiltered query", async () => {
    // Note: no where clause. This is the careless query, and it is safe.
    const alphaVehicles = await withTenant(alpha.clientId, async (tx) => tx.vehicle.findMany());
    const bravoVehicles = await withTenant(bravo.clientId, async (tx) => tx.vehicle.findMany());

    expect(alphaVehicles).toHaveLength(2);
    expect(bravoVehicles).toHaveLength(2);
    expect(alphaVehicles.every((v) => v.clientId === alpha.clientId)).toBe(true);
    expect(bravoVehicles.every((v) => v.clientId === bravo.clientId)).toBe(true);
  });

  it("hides another tenant's row even when its exact primary key is supplied", async () => {
    // The strongest form of the test: we hand the query the real id.
    const stolen = await withTenant(alpha.clientId, async (tx) =>
      tx.vehicle.findUnique({ where: { id: bravo.vehicleId } }),
    );
    expect(stolen).toBeNull();
  });

  it("refuses a write stamped with another tenant's id", async () => {
    await expect(
      withTenant(alpha.clientId, async (tx) =>
        tx.vehicleCategory.create({
          data: { clientId: bravo.clientId, code: "INJECTED", name: "Injected" },
        }),
      ),
    ).rejects.toThrow();

    const bravoCategories = await withTenant(bravo.clientId, async (tx) => tx.vehicleCategory.findMany());
    expect(bravoCategories.map((c) => c.code)).not.toContain("INJECTED");
  });

  it("cannot update another tenant's row, and reports zero rows affected rather than succeeding", async () => {
    const result = await withTenant(alpha.clientId, async (tx) =>
      tx.vehicle.updateMany({ where: { id: bravo.vehicleId }, data: { dailyRateMinor: 1 } }),
    );
    expect(result.count).toBe(0);

    const untouched = await withTenant(bravo.clientId, async (tx) =>
      tx.vehicle.findUnique({ where: { id: bravo.vehicleId } }),
    );
    expect(untouched?.dailyRateMinor).toBe(300_000);
  });

  it("cannot delete another tenant's row", async () => {
    const result = await withTenant(alpha.clientId, async (tx) =>
      tx.vehicle.deleteMany({ where: { id: bravo.vehicleId } }),
    );
    expect(result.count).toBe(0);
    expect(await withTenant(bravo.clientId, async (tx) => tx.vehicle.count())).toBe(2);
  });

  it("isolates aggregates, so a count cannot leak the size of another fleet", async () => {
    await withTenant(bravo.clientId, async (tx) => {
      await tx.vehicle.create({
        data: {
          clientId: bravo.clientId, categoryId: bravo.categoryId, make: "Ferrari", model: "F8",
          year: 2023, plateNumber: "BRAVO-3", dailyRateMinor: 400_000,
        },
      });
    });

    expect(await withTenant(alpha.clientId, async (tx) => tx.vehicle.count())).toBe(2);
    expect(await withTenant(bravo.clientId, async (tx) => tx.vehicle.count())).toBe(3);
  });

  it("isolates the ledger, so one client's revenue is invisible to another", async () => {
    await withTenant(bravo.clientId, async (tx) => {
      await tx.platformAuditLog.create({
        data: { clientId: bravo.clientId, eventType: "BOOKING_SECURED", revenueMinor: 5_000_000, kirmiFeeMinor: 250_000 },
      });
    });

    const alphaTotal = await withTenant(alpha.clientId, async (tx) =>
      tx.platformAuditLog.aggregate({ _sum: { revenueMinor: true } }),
    );
    const bravoTotal = await withTenant(bravo.clientId, async (tx) =>
      tx.platformAuditLog.aggregate({ _sum: { revenueMinor: true } }),
    );

    expect(alphaTotal._sum.revenueMinor).toBeNull();
    expect(bravoTotal._sum.revenueMinor).toBe(5_000_000);
  });

  it("isolates a raw SQL query too, not just the ORM", async () => {
    // Prisma is not the thing enforcing this. Raw SQL is confined identically.
    const rows = await withTenant(alpha.clientId, async (tx) =>
      tx.$queryRaw<Array<{ count: bigint }>>`SELECT count(*)::bigint AS count FROM vehicles`,
    );
    expect(Number(rows[0]?.count ?? -1)).toBe(2);
  });

  it("sees nothing at all when no tenant is in scope, rather than seeing everything", async () => {
    // The fail closed property. An unscoped connection is an empty database.
    const rows = await prisma().$queryRaw<Array<{ count: bigint }>>`SELECT count(*)::bigint AS count FROM vehicles`;
    expect(Number(rows[0]?.count ?? -1)).toBe(0);
  });

  it("does not leak the tenant setting onto the next user of a pooled connection", async () => {
    // set_config(..., true) is transaction local. This is the test that the
    // `true` is actually there: without it, the setting survives the commit and
    // the next borrower of this connection inherits someone else's tenant.
    await withTenant(alpha.clientId, async (tx) => tx.vehicle.count());

    const leaked = await prisma().$queryRaw<Array<{ value: string | null }>>`
      SELECT current_setting('app.current_client_id', true) AS value
    `;
    expect(leaked[0]?.value ?? null).toBeFalsy();
  });

  it("refuses to route to a suspended tenant", async () => {
    await ownerClient().$executeRawUnsafe(
      `UPDATE tenant_directory SET status = 'SUSPENDED' WHERE client_id = '${alpha.clientId}'`,
    );

    const { ClientConfigService } = await import("../../src/services/client-config.service.js");
    const { createContextCache } = await import("../../src/cache/conversation-context.cache.js");
    const { tenantDatabase } = await import("../../src/db/tenant-context.js");
    const { logger } = await import("../../src/core/logger.js");

    const service = new ClientConfigService(tenantDatabase, createContextCache(), logger());
    await expect(service.resolveRouting({ kind: "slug", value: "alpha" })).rejects.toThrow(TenantResolutionError);
  });

  it("keeps the routing projection in step with the tenant automatically", async () => {
    // The projection is maintained by database triggers, not application code,
    // so it cannot drift no matter which code path writes the client row.
    const before = await ownerClient().tenantDirectory.findUnique({ where: { clientId: alpha.clientId } });
    expect(before?.slug).toBe("alpha");

    await withTenant(alpha.clientId, async (tx) => {
      await tx.client.update({ where: { id: alpha.clientId }, data: { tradingName: "Alpha Renamed" } });
    });

    const after = await ownerClient().tenantDirectory.findUnique({ where: { clientId: alpha.clientId } });
    expect(after?.tradingName).toBe("Alpha Renamed");
  });
});

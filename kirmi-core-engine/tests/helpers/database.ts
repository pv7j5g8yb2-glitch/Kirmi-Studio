import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { DEFAULT_OPENING_HOURS } from "../../src/config/tenant-defaults.js";
import { encryptSecret } from "../../src/core/crypto.js";
import { withTenant } from "../../src/db/tenant-context.js";

/**
 * Integration test harness.
 *
 * The integration suite runs against a real PostgreSQL with the real
 * migrations applied, because the properties being tested, row level security
 * and pessimistic row locks, are properties of the database. A mock cannot
 * demonstrate that FOR UPDATE NOWAIT prevents a double booking; only Postgres
 * can, and a test that mocks it proves only that the mock agrees with itself.
 *
 * When no database is reachable the integration suite skips rather than fails,
 * so `npm test` still works on a laptop with nothing running.
 */

const MIGRATION_URL =
  process.env["MIGRATION_DATABASE_URL"] ?? "postgresql://kirmi_migrate:local@127.0.0.1:55432/kirmi_test?schema=public";

let owner: PrismaClient | null = null;

/** A client on the owner role, for setup and teardown the app role cannot do. */
export function ownerClient(): PrismaClient {
  if (!owner) owner = new PrismaClient({ datasources: { db: { url: MIGRATION_URL } } });
  return owner;
}

export async function databaseAvailable(): Promise<boolean> {
  try {
    await ownerClient().$queryRaw`SELECT 1`;
    return true;
  } catch {
    return false;
  }
}

export async function redisAvailable(): Promise<boolean> {
  const { redis } = await import("../../src/cache/redis.js");
  try {
    await redis().ping();
    return true;
  } catch {
    return false;
  }
}

/** Apply migrations to the test database. Idempotent. */
export function migrate(): void {
  execFileSync("npx", ["prisma", "migrate", "deploy"], {
    env: { ...process.env, DATABASE_URL: MIGRATION_URL },
    stdio: "ignore",
  });
}

/**
 * Wipe every tenant table between tests.
 *
 * TRUNCATE rather than DELETE, which also sidesteps the append only trigger on
 * the ledger: that trigger guards UPDATE and DELETE, which is exactly what it
 * should do, and a test fixture reset is not either of those.
 */
export async function resetDatabase(): Promise<void> {
  await ownerClient().$executeRawUnsafe(`
    TRUNCATE TABLE
      platform_audit_logs, webhook_events, escalations, reservations, quotes,
      messages, conversations, customer_identities, customers,
      vehicles, vehicle_categories, client_api_keys, client_configurations,
      tenant_directory, clients
    RESTART IDENTITY CASCADE
  `);
}

export interface SeededTenant {
  clientId: string;
  slug: string;
  categoryId: string;
  vehicleId: string;
  secondVehicleId: string;
  customerId: string;
}

/**
 * Create a complete tenant through the same tenant scoped path the application
 * uses. Nothing here bypasses row level security, so if isolation were broken
 * this helper would be the first thing to fail.
 */
export async function seedTenant(slug: string, options: { metaPhoneNumberId?: string } = {}): Promise<SeededTenant> {
  const clientId = randomUUID();

  return withTenant(clientId, async (tx) => {
    await tx.client.create({
      data: {
        id: clientId,
        slug,
        legalName: `${slug} LLC`,
        tradingName: `${slug} Rental`,
        tradeLicenceNumber: `TL-${slug}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
        currency: "AED",
        timezone: "Asia/Dubai",
        status: "ACTIVE",
      },
    });

    await tx.clientConfiguration.create({
      data: {
        clientId,
        openingHours: DEFAULT_OPENING_HOURS as object,
        vatBasisPoints: 500,
        minimumDriverAge: 25,
        categoryAgeOverrides: { SUPERCAR: 30 },
        deliveryFeeMinor: 15_000,
        freeDeliveryThresholdDays: 7,
        defaultDepositMinor: 500_000,
        seasonalModifiers: [],
        addOnCatalogue: [],
        escalationTargets: [],
        escalationRules: {},
        holdTtlMinutes: 30,
        quoteValidMinutes: 120,
        feeModel: "HYBRID",
        retainerMinor: 800_000,
        commissionBasisPoints: 500,
        metaAppSecretEncrypted: encryptSecret(`${slug}-meta-secret`),
        metaVerifyToken: `${slug}-verify`,
        messageTemplates: [
          {
            kind: "QUOTE_NO_REPLY",
            name: "quote_follow_up",
            language: "en",
            bodyParams: ["customerName", "vehicleName"],
            freeFormBody: "Hi {{customerName}}, still want the {{vehicleName}}?",
          },
        ],
        followUpPolicy: {
          rules: [{ kind: "QUOTE_NO_REPLY", enabled: true, delayMinutes: 1_440, maxAttempts: 2, repeatAfterMinutes: 2_880 }],
          // Off in tests: quiet hours would make every assertion depend on what
          // time of day the suite happened to run.
          quietHours: null,
        },
        ...(options.metaPhoneNumberId ? { metaPhoneNumberId: options.metaPhoneNumberId } : {}),
      },
    });

    const category = await tx.vehicleCategory.create({
      data: { clientId, code: "LUXURY_SUV", name: "Luxury SUV", sortOrder: 1 },
    });

    const vehicle = await tx.vehicle.create({
      data: {
        clientId,
        categoryId: category.id,
        make: "Lamborghini",
        model: "Urus S",
        year: 2024,
        plateNumber: `${slug.toUpperCase()}-1`,
        dailyRateMinor: 300_000,
        weeklyRateMinor: 1_800_000,
        monthlyRateMinor: 6_600_000,
        depositMinor: 1_000_000,
        status: "AVAILABLE",
      },
    });

    const second = await tx.vehicle.create({
      data: {
        clientId,
        categoryId: category.id,
        make: "Mercedes-Benz",
        model: "G 63 AMG",
        year: 2024,
        plateNumber: `${slug.toUpperCase()}-2`,
        dailyRateMinor: 190_000,
        status: "AVAILABLE",
      },
    });

    const customer = await tx.customer.create({
      data: {
        clientId,
        fullName: `${slug} customer`,
        dateOfBirth: new Date("1990-01-01"),
        licenceIssuedOn: new Date("2012-01-01"),
        documentsVerifiedAt: new Date(),
      },
    });

    return {
      clientId,
      slug,
      categoryId: category.id,
      vehicleId: vehicle.id,
      secondVehicleId: second.id,
      customerId: customer.id,
    };
  });
}

/** A window a few days out, so it never trips the "window in the past" rule. */
export function futureWindow(days = 3): { startAt: Date; endAt: Date } {
  const startAt = new Date(Date.now() + 7 * 24 * 3_600_000);
  return { startAt, endAt: new Date(startAt.getTime() + days * 24 * 3_600_000) };
}

export async function closeHarness(): Promise<void> {
  if (owner) {
    await owner.$disconnect();
    owner = null;
  }
}

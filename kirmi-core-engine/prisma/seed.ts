import { randomUUID } from "node:crypto";
import { DEFAULT_OPENING_HOURS, TENANT_DEFAULTS } from "../src/config/tenant-defaults.js";
import { encryptSecret, generateApiKey, parseApiKey, sha256Hex } from "../src/core/crypto.js";
import { logger } from "../src/core/logger.js";
import { disconnectPrisma } from "../src/db/prisma.js";
import { withTenant } from "../src/db/tenant-context.js";

/**
 * ===========================================================================
 * ONBOARDING ONE CLIENT
 * ===========================================================================
 *
 * This script is the proof of the productisation claim. Read it and notice
 * what is absent: it touches no file in src/, adds no branch, registers no
 * route, and defines no client specific behaviour. It writes rows.
 *
 * Onboarding the next client means copying this file, changing the values, and
 * running it. Nothing is deployed.
 *
 * It also runs entirely through the same tenant scoped path the application
 * uses, with app.current_client_id set to the client being created. It does not
 * bypass row level security, which means if isolation were broken, this script
 * would be the first thing to fail.
 *
 *   npm run db:seed
 */

const log = logger();

async function main(): Promise<void> {
  // The id is generated first because every write below, including the client's
  // own row, happens inside that client's isolation scope.
  const clientId = randomUUID();
  const slug = "deiz";

  await withTenant(clientId, async (tx) => {
    log.info({ clientId, slug }, "creating tenant");

    await tx.client.create({
      data: {
        id: clientId,
        slug,
        legalName: "DEIZ Rental LLC",
        tradingName: "DEIZ Rental Dubai",
        tradeLicenceNumber: `TL-DEIZ-${Date.now()}`,
        jurisdiction: "AE-DU",
        currency: "AED",
        timezone: "Asia/Dubai",
        status: "ACTIVE",
        onboardedAt: new Date(),
      },
    });

    await tx.clientConfiguration.create({
      data: {
        clientId,
        openingHours: DEFAULT_OPENING_HOURS as object,
        supportedLanguages: ["en", "ar", "ru"],
        defaultLanguage: "en",

        // Hard gates. A supercar carries a higher bar than the general fleet,
        // which is a configuration decision, not a code path.
        minimumDriverAge: 25,
        minimumLicenceYears: 1,
        requiredDocuments: ["passport", "driving_licence", "visa_or_entry_stamp"],
        categoryAgeOverrides: { SUPERCAR: 30 },

        vatBasisPoints: TENANT_DEFAULTS.vatBasisPoints, // UAE VAT, 5%
        weeklyThresholdDays: 7,
        monthlyThresholdDays: 28,
        deliveryFeeMinor: 15_000, // AED 150
        freeDeliveryThresholdDays: 7,
        defaultDepositMinor: 500_000, // AED 5,000

        seasonalModifiers: [
          {
            code: "NEW_YEAR",
            label: "New Year peak",
            startsOn: "2026-12-20",
            endsOn: "2027-01-05",
            multiplierBasisPoints: 13_000, // +30%
            categoryCodes: [],
          },
          {
            code: "SUMMER_LOW",
            label: "Summer",
            startsOn: "2026-06-15",
            endsOn: "2026-08-31",
            multiplierBasisPoints: 8_500, // -15%
            categoryCodes: [],
          },
        ],

        addOnCatalogue: [
          { code: "CHILD_SEAT", label: "Child seat", unit: "PER_RENTAL", priceMinor: 7_500, mandatoryForCategoryCodes: [] },
          { code: "ADDITIONAL_DRIVER", label: "Additional driver", unit: "PER_RENTAL", priceMinor: 15_000, mandatoryForCategoryCodes: [] },
          { code: "AIRPORT_DELIVERY", label: "Airport delivery", unit: "PER_RENTAL", priceMinor: 25_000, mandatoryForCategoryCodes: [] },
          { code: "EXTRA_KM", label: "Extra kilometre bundle", unit: "PER_DAY", priceMinor: 5_000, mandatoryForCategoryCodes: [] },
        ],

        quoteValidMinutes: 120,
        holdTtlMinutes: 30,

        // Channel credentials. Secrets are encrypted at rest with
        // SECRETS_ENCRYPTION_KEY; replace these placeholders with the real
        // values from the client's Meta and Twilio consoles.
        metaAppSecretEncrypted: encryptSecret("replace-with-real-meta-app-secret"),
        metaVerifyToken: "replace-with-real-verify-token",
        metaPhoneNumberId: "000000000000000",
        metaAccessTokenEncrypted: encryptSecret("replace-with-real-meta-access-token"),
        twilioAuthTokenEncrypted: encryptSecret("replace-with-real-twilio-auth-token"),
        twilioNumber: "+97140000000",
        paymentAccessKeys: { provider: "manual", depositCaptureBasisPoints: 10_000 },

        escalationTargets: [
          { kind: "socket", target: "inbox", hours: "ALWAYS", reasons: [] },
          { kind: "whatsapp", target: "+971500000000", hours: "ALWAYS", reasons: ["AGE_BELOW_MINIMUM", "CUSTOM_RATE_REQUEST"] },
        ],
        escalationRules: {
          AGE_BELOW_MINIMUM: "IMMEDIATE",
          CUSTOM_RATE_REQUEST: "IMMEDIATE",
          DOCUMENT_CHECK_FAILED: "IMMEDIATE",
          LOW_CONFIDENCE: "IMMEDIATE",
          SLA_BREACH: "BATCHED",
        },

        agentDisplayName: "Sara",
        agentToneNotes: "Warm, brief, never pushy. Match the customer's language. Short sentences.",

        // Kirmi's commercial terms with this client. Variable by fleet size, so
        // it lives here rather than in a platform constant.
        feeModel: "HYBRID",
        retainerMinor: 800_000, // AED 8,000 a month
        commissionBasisPoints: 500, // 5% of secured bookings
      },
    });

    // --- fleet -----------------------------------------------------------
    const categories = [
      { code: "SUPERCAR", name: "Supercar", bodyType: "coupe", seats: 2, sortOrder: 1 },
      { code: "LUXURY_SUV", name: "Luxury SUV", bodyType: "suv", seats: 5, sortOrder: 2 },
      { code: "LUXURY_SALOON", name: "Luxury saloon", bodyType: "saloon", seats: 5, sortOrder: 3 },
    ];

    const categoryIds = new Map<string, string>();
    for (const category of categories) {
      const created = await tx.vehicleCategory.create({ data: { clientId, ...category } });
      categoryIds.set(category.code, created.id);
    }

    const fleet = [
      { categoryCode: "SUPERCAR", make: "Lamborghini", model: "Huracan EVO", year: 2024, colour: "Verde Mantis", plateNumber: "DXB-A-11111", dailyRateMinor: 350_000, weeklyRateMinor: 2_100_000, monthlyRateMinor: 7_500_000, depositMinor: 1_500_000 },
      { categoryCode: "SUPERCAR", make: "Ferrari", model: "F8 Tributo", year: 2023, colour: "Rosso Corsa", plateNumber: "DXB-A-22222", dailyRateMinor: 400_000, weeklyRateMinor: 2_450_000, monthlyRateMinor: 8_800_000, depositMinor: 1_500_000 },
      { categoryCode: "LUXURY_SUV", make: "Lamborghini", model: "Urus S", year: 2024, colour: "Nero", plateNumber: "DXB-B-33333", dailyRateMinor: 300_000, weeklyRateMinor: 1_800_000, monthlyRateMinor: 6_600_000, depositMinor: 1_000_000 },
      { categoryCode: "LUXURY_SUV", make: "Mercedes-Benz", model: "G 63 AMG", year: 2024, colour: "Obsidian Black", plateNumber: "DXB-B-44444", dailyRateMinor: 190_000, weeklyRateMinor: 1_150_000, monthlyRateMinor: 4_200_000, depositMinor: 750_000 },
      { categoryCode: "LUXURY_SALOON", make: "Rolls-Royce", model: "Ghost", year: 2023, colour: "Arctic White", plateNumber: "DXB-C-55555", dailyRateMinor: 450_000, weeklyRateMinor: 2_700_000, monthlyRateMinor: 9_900_000, depositMinor: 2_000_000 },
      { categoryCode: "LUXURY_SALOON", make: "BMW", model: "7 Series", year: 2024, colour: "Mineral Grey", plateNumber: "DXB-C-66666", dailyRateMinor: 95_000, weeklyRateMinor: 570_000, monthlyRateMinor: 2_100_000, depositMinor: 300_000 },
    ];

    for (const vehicle of fleet) {
      const categoryId = categoryIds.get(vehicle.categoryCode);
      if (!categoryId) continue;
      // categoryCode is a lookup key in the literal above, not a column.
      const { categoryCode: _unused, ...columns } = vehicle;
      await tx.vehicle.create({
        data: {
          clientId,
          categoryId,
          ...columns,
          status: "AVAILABLE",
          active: true,
          includedKmPerDay: 250,
          extraKmRateMinor: 1_500,
        },
      });
    }

    // --- dashboard credentials -------------------------------------------
    // Shown once. Only the hash is kept, so a database dump is not a set of
    // working keys.
    const apiKey = generateApiKey(slug);
    const parsed = parseApiKey(apiKey);
    if (!parsed) throw new Error("generated an API key that does not parse, which should be impossible");

    await tx.clientApiKey.create({
      data: {
        clientId,
        label: "Dashboard (seed)",
        keyPrefix: parsed.prefix,
        keyHash: sha256Hex(apiKey),
        scopes: ["metrics:read", "inbox:read", "inbox:write"],
      },
    });

    log.info({ clientId, vehicles: fleet.length, categories: categories.length }, "tenant seeded");
    // eslint-disable-next-line no-console
    console.log(
      [
        "",
        "  Tenant ready.",
        `    clientId:  ${clientId}`,
        `    slug:      ${slug}`,
        `    API key:   ${apiKey}`,
        "",
        "  Store that key now. It is not recoverable, only its hash is stored.",
        "",
        `    curl -H "Authorization: Bearer ${apiKey}" http://localhost:3000/api/metrics/summary`,
        "",
      ].join("\n"),
    );
  });
}

main()
  .catch((err: unknown) => {
    log.fatal({ err }, "seed failed");
    process.exitCode = 1;
  })
  .finally(() => {
    void disconnectPrisma();
  });

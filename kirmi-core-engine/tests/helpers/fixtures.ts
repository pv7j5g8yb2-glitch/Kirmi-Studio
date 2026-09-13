import type { TenantProfile, VehicleSnapshot } from "../../src/core/types.js";

/**
 * Plain object fixtures.
 *
 * Every one of these is a literal rather than a database row, which is the
 * point of keeping the pricing and availability engines pure: the tests that
 * matter most run in milliseconds with no infrastructure at all.
 */

export function tenantFixture(overrides: Partial<TenantProfile> = {}): TenantProfile {
  return {
    clientId: "11111111-1111-4111-8111-111111111111",
    slug: "deiz",
    legalName: "DEIZ Rental LLC",
    tradingName: "DEIZ Rental Dubai",
    currency: "AED",
    timezone: "Asia/Dubai",
    status: "ACTIVE",
    languages: { supported: ["en", "ar", "ru"], default: "en" },
    qualification: {
      minimumDriverAge: 25,
      minimumLicenceYears: 1,
      requiredDocuments: ["passport", "driving_licence"],
      categoryAgeOverrides: { SUPERCAR: 30 },
    },
    pricing: {
      vatBasisPoints: 500,
      weeklyThresholdDays: 7,
      monthlyThresholdDays: 28,
      deliveryFeeMinor: 15_000,
      freeDeliveryThresholdDays: 7,
      defaultDepositMinor: 500_000,
      seasonalModifiers: [],
      addOnCatalogue: [
        { code: "CHILD_SEAT", label: "Child seat", unit: "PER_RENTAL", priceMinor: 7_500, mandatoryForCategoryCodes: [] },
        { code: "EXTRA_KM", label: "Extra km", unit: "PER_DAY", priceMinor: 5_000, mandatoryForCategoryCodes: [] },
      ],
      quoteValidMinutes: 120,
      holdTtlMinutes: 30,
    },
    openingHours: { mon: [], tue: [], wed: [], thu: [], fri: [], sat: [], sun: [], exceptions: [] },
    escalation: { targets: [], rules: {} },
    billing: { feeModel: "HYBRID", retainerMinor: 800_000, commissionBasisPoints: 500 },
    agent: { displayName: "Sara", toneNotes: null, systemPromptExtra: null },
    channels: {
      metaPhoneNumberId: "1234567890",
      metaBusinessAccountId: null,
      instagramScopedPageId: null,
      twilioNumber: "+97140000000",
    },
    ...overrides,
  };
}

export function vehicleFixture(overrides: Partial<VehicleSnapshot> = {}): VehicleSnapshot {
  return {
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    categoryId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    categoryCode: "LUXURY_SUV",
    make: "Lamborghini",
    model: "Urus S",
    year: 2024,
    plateNumber: "DXB-B-33333",
    dailyRateMinor: 300_000, // AED 3,000
    weeklyRateMinor: 1_800_000, // AED 18,000
    monthlyRateMinor: 6_600_000, // AED 66,000
    depositMinor: 1_000_000,
    status: "AVAILABLE",
    active: true,
    offRoadUntil: null,
    ...overrides,
  };
}

/** A window starting at a fixed instant, so seasonal tests are deterministic. */
export function window(days: number, startIso = "2026-03-10T08:00:00.000Z"): { startAt: Date; endAt: Date } {
  const startAt = new Date(startIso);
  return { startAt, endAt: new Date(startAt.getTime() + days * 24 * 3_600_000) };
}

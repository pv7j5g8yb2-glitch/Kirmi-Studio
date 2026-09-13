import { describe, expect, it } from "vitest";
import { calculateKirmiFee, calculatePrice } from "../../src/core/pricing/pricing.engine.js";
import { PricingError } from "../../src/core/errors.js";
import { tenantFixture, vehicleFixture, window } from "../helpers/fixtures.js";

/**
 * The pricing engine is the thing the LLM is forbidden from doing, so it is the
 * thing that has to be right. These tests assert exact integer totals, not
 * approximations: a fil of drift is a customer disputing an invoice.
 */
describe("pricing engine", () => {
  const tenant = tenantFixture();
  const vehicle = vehicleFixture();

  it("prices a short hire at the daily rate, with VAT on the subtotal", () => {
    const { startAt, endAt } = window(3);
    const price = calculatePrice({
      tenant,
      vehicle,
      categoryCode: "LUXURY_SUV",
      startAt,
      endAt,
      deliveryRequested: false,
      addOns: [],
    });

    expect(price.durationDays).toBe(3);
    expect(price.rateBracket).toBe("DAILY");
    expect(price.baseFareMinor).toBe(900_000); // 3,000 x 3
    expect(price.subtotalMinor).toBe(900_000);
    expect(price.vatMinor).toBe(45_000); // 5% of 900,000
    expect(price.totalMinor).toBe(945_000); // AED 9,450
  });

  it("drops to the weekly rate once the hire reaches the threshold", () => {
    const { startAt, endAt } = window(7);
    const price = calculatePrice({
      tenant, vehicle, categoryCode: "LUXURY_SUV", startAt, endAt, deliveryRequested: false, addOns: [],
    });

    expect(price.rateBracket).toBe("WEEKLY");
    expect(price.units).toBe(1);
    expect(price.baseFareMinor).toBe(1_800_000);
    // Seven daily would have been 2,100,000. The customer gets the cheaper one.
    expect(price.baseFareMinor).toBeLessThan(vehicle.dailyRateMinor * 7);
  });

  it("bills a ten day hire as one week plus three days", () => {
    const { startAt, endAt } = window(10);
    const price = calculatePrice({
      tenant, vehicle, categoryCode: "LUXURY_SUV", startAt, endAt, deliveryRequested: false, addOns: [],
    });

    expect(price.rateBracket).toBe("WEEKLY");
    expect(price.units).toBe(1);
    expect(price.remainderDays).toBe(3);
    expect(price.baseFareMinor).toBe(1_800_000 + 3 * 300_000); // 2,700,000
  });

  it("never charges more than the cheapest available bracket", () => {
    // A vehicle whose weekly rate is worse value than seven daily hires. The
    // engine must not apply it just because the duration qualifies.
    const badlyPriced = vehicleFixture({ weeklyRateMinor: 2_500_000, monthlyRateMinor: null });
    const { startAt, endAt } = window(7);

    const price = calculatePrice({
      tenant, vehicle: badlyPriced, categoryCode: "LUXURY_SUV", startAt, endAt, deliveryRequested: false, addOns: [],
    });

    expect(price.rateBracket).toBe("DAILY");
    expect(price.baseFareMinor).toBe(2_100_000);
  });

  it("applies a seasonal modifier in basis points, on the start date in the client's timezone", () => {
    const peak = tenantFixture({
      pricing: {
        ...tenant.pricing,
        seasonalModifiers: [
          { code: "NEW_YEAR", startsOn: "2026-12-20", endsOn: "2027-01-05", multiplierBasisPoints: 13_000, categoryCodes: [] },
        ],
      },
    });

    // 19 December 22:00 UTC is already 20 December in Dubai, so this hire is in
    // the peak window. Matching on UTC would have missed it.
    const startAt = new Date("2026-12-19T22:00:00.000Z");
    const endAt = new Date(startAt.getTime() + 2 * 24 * 3_600_000);

    const price = calculatePrice({
      tenant: peak, vehicle, categoryCode: "LUXURY_SUV", startAt, endAt, deliveryRequested: false, addOns: [],
    });

    expect(price.seasonalCode).toBe("NEW_YEAR");
    expect(price.baseFareMinor).toBe(600_000);
    expect(price.adjustedBaseMinor).toBe(780_000); // +30%
    expect(price.seasonalAdjustmentMinor).toBe(180_000);
    expect(price.totalMinor).toBe(819_000); // 780,000 + 5% VAT
  });

  it("charges delivery, and waives it on hires long enough to qualify", () => {
    const short = calculatePrice({
      tenant, vehicle, categoryCode: "LUXURY_SUV", ...window(3), deliveryRequested: true, addOns: [],
    });
    expect(short.deliveryFeeMinor).toBe(15_000);
    expect(short.deliveryWaived).toBe(false);

    const long = calculatePrice({
      tenant, vehicle, categoryCode: "LUXURY_SUV", ...window(7), deliveryRequested: true, addOns: [],
    });
    expect(long.deliveryFeeMinor).toBe(0);
    expect(long.deliveryWaived).toBe(true);
  });

  it("multiplies per-day add-ons by duration and leaves per-rental ones flat", () => {
    const price = calculatePrice({
      tenant, vehicle, categoryCode: "LUXURY_SUV", ...window(4), deliveryRequested: false,
      addOns: [{ code: "CHILD_SEAT" }, { code: "EXTRA_KM" }],
    });

    const childSeat = price.addOnLines.find((l) => l.code === "CHILD_SEAT");
    const extraKm = price.addOnLines.find((l) => l.code === "EXTRA_KM");

    expect(childSeat?.totalMinor).toBe(7_500);
    expect(extraKm?.quantity).toBe(4);
    expect(extraKm?.totalMinor).toBe(20_000);
    expect(price.addOnsTotalMinor).toBe(27_500);
  });

  it("refuses an add-on that is not in this client's catalogue", () => {
    expect(() =>
      calculatePrice({
        tenant, vehicle, categoryCode: "LUXURY_SUV", ...window(2), deliveryRequested: false,
        addOns: [{ code: "HELICOPTER_TRANSFER" }],
      }),
    ).toThrow(PricingError);
  });

  it("refuses a backwards rental window rather than pricing it as free", () => {
    const startAt = new Date("2026-03-10T08:00:00.000Z");
    const endAt = new Date("2026-03-09T08:00:00.000Z");
    expect(() =>
      calculatePrice({ tenant, vehicle, categoryCode: "LUXURY_SUV", startAt, endAt, deliveryRequested: false, addOns: [] }),
    ).toThrow();
  });

  it("rounds a rental up to whole days, minimum one", () => {
    const startAt = new Date("2026-03-10T08:00:00.000Z");
    const fourHours = calculatePrice({
      tenant, vehicle, categoryCode: "LUXURY_SUV", startAt,
      endAt: new Date(startAt.getTime() + 4 * 3_600_000), deliveryRequested: false, addOns: [],
    });
    expect(fourHours.durationDays).toBe(1);

    const twentyFive = calculatePrice({
      tenant, vehicle, categoryCode: "LUXURY_SUV", startAt,
      endAt: new Date(startAt.getTime() + 25 * 3_600_000), deliveryRequested: false, addOns: [],
    });
    expect(twentyFive.durationDays).toBe(2);
  });

  it("produces the same result every time for the same inputs", () => {
    const args = { tenant, vehicle, categoryCode: "LUXURY_SUV", ...window(9), deliveryRequested: true, addOns: [{ code: "CHILD_SEAT" }] };
    const first = calculatePrice(args);
    const second = calculatePrice(args);
    expect(second).toEqual(first);
  });

  it("keeps every figure an integer, so no float ever reaches an invoice", () => {
    const price = calculatePrice({
      tenant, vehicle, categoryCode: "LUXURY_SUV", ...window(13), deliveryRequested: true,
      addOns: [{ code: "EXTRA_KM" }],
    });

    for (const [field, value] of Object.entries(price)) {
      if (typeof value === "number") {
        expect(Number.isInteger(value), `${field} was ${value}`).toBe(true);
      }
    }
    // And the totals reconcile exactly.
    expect(price.subtotalMinor).toBe(price.adjustedBaseMinor + price.deliveryFeeMinor + price.addOnsTotalMinor);
    expect(price.totalMinor).toBe(price.subtotalMinor + price.vatMinor);
  });
});

describe("kirmi fee", () => {
  it("takes a commission on a hybrid deal", () => {
    expect(calculateKirmiFee(1_000_000, { feeModel: "HYBRID", commissionBasisPoints: 500 })).toBe(50_000);
  });

  it("takes nothing per booking on a pure retainer", () => {
    expect(calculateKirmiFee(1_000_000, { feeModel: "RETAINER", commissionBasisPoints: 500 })).toBe(0);
  });
});

describe("retainer proration", () => {
  /**
   * Reaching the private method through the service's own shape, because the
   * rule it encodes is arithmetic and belongs with the other arithmetic tests.
   * The naive "calendar months touched" version reports two months of retainer
   * for the rolling 30 day window the dashboard defaults to, every day of the
   * year, which is the bug these cases exist to prevent coming back.
   */
  const retainerFor = async (from: string, to: string): Promise<number> => {
    const { MetricsService } = await import("../../src/services/metrics.service.js");
    const service = new MetricsService({} as never);
    const tenant = tenantFixture();
    return (
      service as unknown as {
        retainerForWindow(t: typeof tenant, w: { from: Date; to: Date }): number;
      }
    ).retainerForWindow(tenant, { from: new Date(from), to: new Date(to) });
  };

  it("charges exactly one retainer for one whole calendar month", async () => {
    // An invoice period must reconcile to the penny.
    expect(await retainerFor("2026-03-01T00:00:00Z", "2026-04-01T00:00:00Z")).toBe(800_000);
    expect(await retainerFor("2026-02-01T00:00:00Z", "2026-03-01T00:00:00Z")).toBe(800_000);
  });

  it("charges about one retainer for a rolling 30 day window that straddles two months", async () => {
    const value = await retainerFor("2026-08-14T00:00:00Z", "2026-09-13T00:00:00Z");
    expect(value).toBeGreaterThan(750_000);
    expect(value).toBeLessThan(850_000);
  });

  it("charges two retainers for two whole months", async () => {
    expect(await retainerFor("2026-03-01T00:00:00Z", "2026-05-01T00:00:00Z")).toBe(1_600_000);
  });

  it("charges nothing on a pure commission deal", async () => {
    const { MetricsService } = await import("../../src/services/metrics.service.js");
    const service = new MetricsService({} as never);
    const commissionOnly = tenantFixture({
      billing: { feeModel: "COMMISSION", retainerMinor: 800_000, commissionBasisPoints: 700 },
    });
    const value = (
      service as unknown as {
        retainerForWindow(t: typeof commissionOnly, w: { from: Date; to: Date }): number;
      }
    ).retainerForWindow(commissionOnly, { from: new Date("2026-03-01T00:00:00Z"), to: new Date("2026-04-01T00:00:00Z") });
    expect(value).toBe(0);
  });
});

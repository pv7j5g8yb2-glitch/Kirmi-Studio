import { PRICING_ENGINE_VERSION } from "../../config/constants.js";
import { PricingError } from "../errors.js";
import { applyBasisPoints, assertMinor, sumMinor, taxOn, type Minor } from "../money.js";
import { rentalDays } from "../time.js";
import type { RateBracketKind } from "../types.js";
import { resolveSeasonalModifier } from "./seasonal.js";
import type { AddOnLine, PriceBreakdown, PricingInput } from "./types.js";

/**
 * ===========================================================================
 * THE PRICING ENGINE
 * ===========================================================================
 *
 * This module is the reason the LLM is not allowed to do arithmetic.
 *
 * A language model asked to price a five day Urus hire with delivery and VAT
 * will produce a number that looks right. It will be right most of the time.
 * The times it is not, a client has quoted a customer a figure they cannot
 * honour, in writing, on WhatsApp. So the model parses text into intent, and
 * every figure a customer ever sees comes out of this function.
 *
 * The contract:
 *
 *   Total = (Base Bracket Rate x Duration x Seasonal Modifier)
 *           + Delivery Fee
 *           + Add-ons
 *           + VAT on that subtotal
 *
 * Pure. No database, no clock, no network, no I/O of any kind. Same inputs,
 * same output, forever, which is what makes a quote reproducible from its
 * stored breakdown months after the fact.
 *
 * Integer arithmetic throughout, in minor units (fils).
 */

interface BracketCandidate {
  bracket: RateBracketKind;
  unitRateMinor: Minor;
  units: number;
  remainderDays: number;
  subtotalMinor: Minor;
  available: boolean;
}

/**
 * Decompose a duration into the cheapest lawful bracket.
 *
 * "Base Bracket Rate x Duration" is the shape of the formula, but a rental desk
 * does not multiply a daily rate by thirty for a month hire. Ten days is a week
 * plus three days, and the customer is charged the weekly rate plus three daily
 * ones. The thresholds come from the tenant's own config, so a client who sells
 * weeks from day five configures five and nothing in this file changes.
 *
 * The cheapest candidate always wins. A customer can never be charged more by
 * qualifying for a longer bracket, which would be both indefensible and the
 * sort of thing that ends up in a screenshot.
 */
function selectBracket(
  days: number,
  dailyRateMinor: Minor,
  weeklyRateMinor: Minor | null,
  monthlyRateMinor: Minor | null,
  weeklyThresholdDays: number,
  monthlyThresholdDays: number,
): { chosen: BracketCandidate; considered: BracketCandidate[] } {
  assertMinor(dailyRateMinor, "daily rate");

  const candidates: BracketCandidate[] = [
    {
      bracket: "DAILY",
      unitRateMinor: dailyRateMinor,
      units: days,
      remainderDays: 0,
      subtotalMinor: dailyRateMinor * days,
      available: true,
    },
  ];

  const longer = (
    bracket: RateBracketKind,
    rate: Minor | null,
    spanDays: number,
  ): BracketCandidate => {
    if (rate === null || days < spanDays || spanDays <= 0) {
      return { bracket, unitRateMinor: rate ?? 0, units: 0, remainderDays: days, subtotalMinor: Number.MAX_SAFE_INTEGER, available: false };
    }
    assertMinor(rate, `${bracket.toLowerCase()} rate`);
    const units = Math.floor(days / spanDays);
    const remainderDays = days - units * spanDays;
    return {
      bracket,
      unitRateMinor: rate,
      units,
      remainderDays,
      subtotalMinor: rate * units + dailyRateMinor * remainderDays,
      available: true,
    };
  };

  candidates.push(longer("WEEKLY", weeklyRateMinor, weeklyThresholdDays));
  candidates.push(longer("MONTHLY", monthlyRateMinor, monthlyThresholdDays));

  const chosen = candidates
    .filter((c) => c.available)
    .reduce((best, c) => (c.subtotalMinor < best.subtotalMinor ? c : best));

  return { chosen, considered: candidates };
}

/**
 * Price a rental. The only function in this codebase permitted to decide what
 * a customer owes.
 */
export function calculatePrice(input: PricingInput): PriceBreakdown {
  const { tenant, vehicle, startAt, endAt, categoryCode } = input;
  const rules = tenant.pricing;

  // --- 1. Duration -------------------------------------------------------
  // Throws on a backwards or zero length window rather than pricing it as free.
  const durationDays = rentalDays(startAt, endAt);

  if (vehicle.dailyRateMinor <= 0) {
    throw new PricingError("Vehicle has no daily rate configured", {
      vehicleId: vehicle.id,
      plateNumber: vehicle.plateNumber,
    });
  }

  // --- 2. Base bracket rate x duration ------------------------------------
  const { chosen, considered } = selectBracket(
    durationDays,
    vehicle.dailyRateMinor,
    vehicle.weeklyRateMinor,
    vehicle.monthlyRateMinor,
    rules.weeklyThresholdDays,
    rules.monthlyThresholdDays,
  );
  const baseFareMinor = chosen.subtotalMinor;

  // --- 3. Seasonal modifier ----------------------------------------------
  const seasonal = resolveSeasonalModifier(rules.seasonalModifiers, startAt, tenant.timezone, categoryCode);
  const adjustedBaseMinor = applyBasisPoints(baseFareMinor, seasonal.basisPoints);
  const seasonalAdjustmentMinor = adjustedBaseMinor - baseFareMinor;

  // --- 4. Delivery --------------------------------------------------------
  // A waiver on long hires is a common closing lever, so it is config, not code.
  const waiverThreshold = rules.freeDeliveryThresholdDays;
  const deliveryWaived =
    input.deliveryRequested && waiverThreshold !== null && durationDays >= waiverThreshold;
  const deliveryFeeMinor = input.deliveryRequested && !deliveryWaived ? rules.deliveryFeeMinor : 0;

  // --- 5. Add-ons ---------------------------------------------------------
  // Resolved strictly against the tenant's own catalogue. An unknown code is an
  // error, never a zero: a silently free child seat is a silently wrong invoice.
  const addOnLines: AddOnLine[] = input.addOns.map((selection) => {
    const definition = rules.addOnCatalogue.find((a) => a.code === selection.code);
    if (!definition) {
      throw new PricingError(`Unknown add-on for this client: ${selection.code}`, {
        code: selection.code,
        available: rules.addOnCatalogue.map((a) => a.code),
      });
    }
    const requested = selection.quantity ?? 1;
    if (!Number.isInteger(requested) || requested < 1) {
      throw new PricingError(`Add-on quantity must be a positive integer: ${selection.code}`);
    }
    const quantity = definition.unit === "PER_DAY" ? requested * durationDays : requested;
    return {
      code: definition.code,
      label: definition.label,
      unit: definition.unit,
      unitPriceMinor: definition.priceMinor,
      quantity,
      totalMinor: definition.priceMinor * quantity,
    };
  });
  const addOnsTotalMinor = sumMinor(addOnLines.map((l) => l.totalMinor));

  // --- 6. Subtotal, VAT, total -------------------------------------------
  const subtotalMinor = adjustedBaseMinor + deliveryFeeMinor + addOnsTotalMinor;
  const vatMinor = taxOn(subtotalMinor, rules.vatBasisPoints);
  const totalMinor = subtotalMinor + vatMinor;

  // Deposit is the vehicle's own if set, otherwise the client default. It sits
  // outside the total: it is held, not charged.
  const depositMinor = vehicle.depositMinor ?? rules.defaultDepositMinor;

  return {
    currency: tenant.currency,
    calcVersion: PRICING_ENGINE_VERSION,

    durationDays,
    rateBracket: chosen.bracket,
    unitRateMinor: chosen.unitRateMinor,
    units: chosen.units,
    remainderDays: chosen.remainderDays,
    remainderRateMinor: chosen.remainderDays > 0 ? vehicle.dailyRateMinor : 0,

    baseFareMinor,

    seasonalCode: seasonal.code,
    seasonalBasisPoints: seasonal.basisPoints,
    seasonalAdjustmentMinor,
    adjustedBaseMinor,

    deliveryRequired: input.deliveryRequested,
    deliveryFeeMinor,
    deliveryWaived,

    addOnLines,
    addOnsTotalMinor,

    subtotalMinor,
    vatBasisPoints: rules.vatBasisPoints,
    vatMinor,
    totalMinor,
    depositMinor,

    bracketsConsidered: considered.map((c) => ({
      bracket: c.bracket,
      subtotalMinor: c.available ? c.subtotalMinor : 0,
      available: c.available,
    })),
  };
}

/**
 * Kirmi Studio's own fee on a booking, computed at the moment the booking is
 * secured and written into the ledger there and then.
 *
 * Computed at event time on purpose. If the fee were derived at invoice time
 * from today's contract, renegotiating a client's rate would silently rewrite
 * every historic month. This way the ledger holds what was actually owed when
 * it was owed.
 */
export function calculateKirmiFee(
  bookingValueMinor: Minor,
  billing: { feeModel: "RETAINER" | "COMMISSION" | "HYBRID"; commissionBasisPoints: number },
): Minor {
  assertMinor(bookingValueMinor, "booking value");
  if (billing.feeModel === "RETAINER") {
    // Flat monthly deal: an individual booking carries no marginal fee. The
    // retainer is attributed once a month by the metrics service instead.
    return 0;
  }
  return applyBasisPoints(bookingValueMinor, billing.commissionBasisPoints);
}

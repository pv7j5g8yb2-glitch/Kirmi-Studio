import { BASIS_POINTS_SCALE, MINOR_UNITS_PER_MAJOR } from "../config/constants.js";

/**
 * Money in this engine is an integer count of the currency's minor unit, fils
 * for AED. No float ever touches a price.
 *
 * This is not fussiness. A float subtotal produces a VAT line that disagrees
 * with the customer's own arithmetic by a fil, and a customer who spots that on
 * an AED 40,000 invoice stops trusting every other number on it.
 */
export type Minor = number;

export function assertMinor(value: number, label = "amount"): Minor {
  if (!Number.isInteger(value)) {
    throw new TypeError(`${label} must be an integer count of minor units, received ${value}`);
  }
  if (!Number.isSafeInteger(value)) {
    throw new TypeError(`${label} exceeds safe integer range`);
  }
  return value;
}

export function toMinor(major: number): Minor {
  if (!Number.isFinite(major)) throw new TypeError("toMinor: not a finite number");
  return Math.round(major * MINOR_UNITS_PER_MAJOR);
}

export function toMajor(minor: Minor): number {
  return minor / MINOR_UNITS_PER_MAJOR;
}

/**
 * Apply a basis point rate, rounding half up, staying in integer space.
 * 10_000 bp is identity, so a modifier of exactly 1.0 is provably a no-op.
 */
export function applyBasisPoints(minor: Minor, basisPoints: number): Minor {
  assertMinor(minor, "base amount");
  if (!Number.isInteger(basisPoints)) {
    throw new TypeError(`basis points must be an integer, received ${basisPoints}`);
  }
  return Math.round((minor * basisPoints) / BASIS_POINTS_SCALE);
}

/** The VAT on a taxable amount, at a basis point rate. */
export function taxOn(taxableMinor: Minor, vatBasisPoints: number): Minor {
  return applyBasisPoints(taxableMinor, vatBasisPoints);
}

export function sumMinor(values: readonly Minor[]): Minor {
  let total = 0;
  for (const v of values) total += assertMinor(v);
  return total;
}

/**
 * Presentation only. Never feed a formatted string back into arithmetic, and
 * never send one to the LLM as a number it might "helpfully" recompute.
 */
export function formatMoney(minor: Minor, currency = "AED", locale = "en-AE"): string {
  const hasFraction = minor % MINOR_UNITS_PER_MAJOR !== 0;
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency,
    minimumFractionDigits: hasFraction ? 2 : 0,
    maximumFractionDigits: 2,
  }).format(toMajor(minor));
}

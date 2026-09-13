/**
 * All money is an integer count of the currency's minor unit (fils for AED).
 * Floats never touch a price: 0.1 + 0.2 problems in a quote become disputes.
 */
export type Minor = number;

export const MINOR_PER_MAJOR = 100;

export function toMinor(major: number): Minor {
  if (!Number.isFinite(major)) throw new Error("toMinor: not a finite number");
  return Math.round(major * MINOR_PER_MAJOR);
}

export function toMajor(minor: Minor): number {
  return minor / MINOR_PER_MAJOR;
}

export function formatMoney(minor: Minor, currency = "AED", locale = "en-AE"): string {
  const value = toMajor(minor);
  const hasFraction = minor % MINOR_PER_MAJOR !== 0;
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency,
    minimumFractionDigits: hasFraction ? 2 : 0,
    maximumFractionDigits: 2,
  }).format(value);
}

/** Percentage of a minor amount, rounded half-up, staying in integer space. */
export function percentOf(minor: Minor, percent: number): Minor {
  return Math.round((minor * percent) / 100);
}

export function sum(values: Minor[]): Minor {
  return values.reduce((a, b) => a + b, 0);
}

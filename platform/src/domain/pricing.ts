import type { Queryable } from "../db/index.js";
import { percentOf } from "../core/money.js";
import { getRules, type TenantRules } from "./settings.js";
import { rentalDays } from "./availability.js";
import type { Vehicle } from "./vehicles.js";

export type PriceBreakdown = {
  days: number;
  rateApplied: "daily" | "weekly" | "monthly";
  /** Unit price of the applied tier, for showing "AED 900 x 4 days". */
  unitRate: number;
  units: number;
  remainderDays: number;
  remainderRate: number;
  subtotal: number;
  deliveryFee: number;
  extras: number;
  vat: number;
  total: number;
  deposit: number;
  currency: string;
  includedKmPerDay: number | null;
  extraKmRate: number | null;
};

export type PriceInput = {
  vehicle: Vehicle;
  startsAt: Date;
  endsAt: Date;
  delivery?: boolean;
  extras?: number;
  rules?: TenantRules;
};

/**
 * Tiered rental pricing. Longer hires fall to the weekly or monthly rate where the
 * tenant publishes one, and any remainder days bill at the daily rate — which is how
 * UAE rental desks actually quote. Never charges more than the equivalent daily total.
 */
export function computePrice(input: PriceInput & { rules: TenantRules }): PriceBreakdown {
  const { vehicle, startsAt, endsAt, rules } = input;
  const days = rentalDays(startsAt, endsAt);
  if (days < 1) throw new Error("computePrice: rental must cover at least one day");

  const daily = vehicle.dailyRate;
  const weekly = vehicle.weeklyRate ?? null;
  const monthly = vehicle.monthlyRate ?? null;

  type Tier = { rateApplied: PriceBreakdown["rateApplied"]; unitRate: number; units: number; remainderDays: number; subtotal: number };
  const candidates: Tier[] = [{ rateApplied: "daily", unitRate: daily, units: days, remainderDays: 0, subtotal: daily * days }];

  if (monthly && days >= rules.monthlyThresholdDays) {
    const span = rules.monthlyThresholdDays;
    const units = Math.floor(days / span);
    const remainder = days - units * span;
    candidates.push({
      rateApplied: "monthly",
      unitRate: monthly,
      units,
      remainderDays: remainder,
      subtotal: monthly * units + daily * remainder,
    });
  }
  if (weekly && days >= rules.weeklyThresholdDays) {
    const span = rules.weeklyThresholdDays;
    const units = Math.floor(days / span);
    const remainder = days - units * span;
    candidates.push({
      rateApplied: "weekly",
      unitRate: weekly,
      units,
      remainderDays: remainder,
      subtotal: weekly * units + daily * remainder,
    });
  }

  // The customer gets the cheapest lawful tier, never the one that happens to be listed.
  const best = candidates.reduce((a, b) => (b.subtotal < a.subtotal ? b : a));

  const freeThreshold = rules.freeDeliveryThresholdDays;
  const deliveryWaived = input.delivery === true && freeThreshold !== null && days >= freeThreshold;
  const deliveryFee = input.delivery === true && !deliveryWaived ? rules.deliveryFee : 0;

  const extras = input.extras ?? 0;
  const taxable = best.subtotal + deliveryFee + extras;
  const vat = percentOf(taxable, rules.vatPercent);
  const total = taxable + vat;
  const deposit = vehicle.deposit > 0 ? vehicle.deposit : rules.depositDefault;

  return {
    days,
    rateApplied: best.rateApplied,
    unitRate: best.unitRate,
    units: best.units,
    remainderDays: best.remainderDays,
    remainderRate: daily,
    subtotal: best.subtotal,
    deliveryFee,
    extras,
    vat,
    total,
    deposit,
    currency: "AED",
    includedKmPerDay: vehicle.dailyKm,
    extraKmRate: vehicle.extraKmRate,
  };
}

export async function priceFor(db: Queryable, tenantId: string, input: PriceInput): Promise<PriceBreakdown> {
  const rules = input.rules ?? (await getRules(db, tenantId));
  return computePrice({ ...input, rules });
}

import type { Minor } from "../money.js";
import type { RateBracketKind, TenantProfile, VehicleSnapshot } from "../types.js";

export interface AddOnSelection {
  code: string;
  /** Only meaningful for PER_DAY add-ons; PER_RENTAL ignores it. */
  quantity?: number;
}

export interface PricingInput {
  tenant: TenantProfile;
  vehicle: VehicleSnapshot;
  /** Category code drives category scoped seasonal windows and age gates. */
  categoryCode: string | null;
  startAt: Date;
  endAt: Date;
  deliveryRequested: boolean;
  addOns: readonly AddOnSelection[];
}

export interface AddOnLine {
  code: string;
  label: string;
  unit: "PER_DAY" | "PER_RENTAL";
  unitPriceMinor: Minor;
  quantity: number;
  totalMinor: Minor;
}

/**
 * The complete, auditable derivation of one price.
 *
 * Every intermediate figure is kept, not just the total. When a client queries
 * an invoice eight months later, "AED 18,375" is not an answer; this object is.
 */
export interface PriceBreakdown {
  currency: string;
  calcVersion: string;

  durationDays: number;
  rateBracket: RateBracketKind;
  unitRateMinor: Minor;
  units: number;
  remainderDays: number;
  remainderRateMinor: Minor;

  /** Bracket arithmetic, before any modifier. */
  baseFareMinor: Minor;

  seasonalCode: string | null;
  seasonalBasisPoints: number;
  seasonalAdjustmentMinor: Minor;
  /** baseFare after the seasonal modifier. */
  adjustedBaseMinor: Minor;

  deliveryRequired: boolean;
  deliveryFeeMinor: Minor;
  deliveryWaived: boolean;

  addOnLines: AddOnLine[];
  addOnsTotalMinor: Minor;

  subtotalMinor: Minor;
  vatBasisPoints: number;
  vatMinor: Minor;
  totalMinor: Minor;
  depositMinor: Minor;

  /** Every bracket considered, so "why not the weekly rate" is answerable. */
  bracketsConsidered: Array<{ bracket: RateBracketKind; subtotalMinor: Minor; available: boolean }>;
}

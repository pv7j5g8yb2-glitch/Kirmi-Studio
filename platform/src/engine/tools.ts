import type { Queryable } from "../db/index.js";
import { searchVehicles, getVehicle, type Vehicle } from "../domain/vehicles.js";
import { checkAvailability, findAvailableVehicles, rentalDays } from "../domain/availability.js";
import { priceFor } from "../domain/pricing.js";
import { getRules } from "../domain/settings.js";
import { createQuote } from "../domain/quotes.js";
import { formatMoney } from "../core/money.js";

/**
 * The tool surface the conversation engine may call. Every answer about a car, a date
 * or a price comes from here — the model never states a fact it did not get from a tool.
 * Each tool returns a `known` flag; when false the engine must escalate rather than guess.
 */

export type ToolContext = { db: Queryable; tenantId: string; now?: Date };

export type SearchResult = {
  known: true;
  matches: Array<{ id: string; label: string; dailyRate: number; deposit: number; minDays: number; category: string }>;
};

export async function toolSearchVehicles(ctx: ToolContext, term: string): Promise<SearchResult> {
  const rows = await searchVehicles(ctx.db, ctx.tenantId, term, 5);
  return {
    known: true,
    matches: rows.map((v) => ({
      id: v.id,
      label: `${v.make} ${v.model}${v.year ? ` ${v.year}` : ""}`,
      dailyRate: v.dailyRate,
      deposit: v.deposit,
      minDays: v.minDays,
      category: v.category,
    })),
  };
}

export type AvailabilityAnswer =
  | { known: false; reason: "no_dates" | "unknown_vehicle" }
  | { known: true; available: boolean; authoritative: boolean; vehicle: Vehicle; alternatives: Array<{ id: string; label: string }> };

export async function toolCheckAvailability(
  ctx: ToolContext,
  input: { vehicleId: string; startsAt: Date | null; endsAt: Date | null },
): Promise<AvailabilityAnswer> {
  if (!input.startsAt || !input.endsAt) return { known: false, reason: "no_dates" };
  const vehicle = await getVehicle(ctx.db, ctx.tenantId, input.vehicleId);
  if (!vehicle) return { known: false, reason: "unknown_vehicle" };

  const res = await checkAvailability(ctx.db, ctx.tenantId, input.vehicleId, input.startsAt, input.endsAt);
  let alternatives: Array<{ id: string; label: string }> = [];
  if (!res.available) {
    // Offer the same category first — a customer refused a G63 wants another SUV.
    const free = await findAvailableVehicles(ctx.db, ctx.tenantId, input.startsAt, input.endsAt);
    alternatives = free
      .filter((v) => v.id !== vehicle.id)
      .sort((a, b) => Number(b.category === vehicle.category) - Number(a.category === vehicle.category))
      .slice(0, 3)
      .map((v) => ({ id: v.id, label: `${v.make} ${v.model}` }));
  }
  return { known: true, available: res.available, authoritative: res.authoritative, vehicle, alternatives };
}

export type QuoteAnswer =
  | { known: false; reason: "no_dates" | "unknown_vehicle" | "below_minimum"; detail?: string }
  | {
      known: true;
      quoteId: string | null;
      vehicle: Vehicle;
      days: number;
      total: number;
      deposit: number;
      subtotal: number;
      vat: number;
      deliveryFee: number;
      currency: string;
      rateApplied: string;
      availabilityConfirmed: boolean;
      includedKmPerDay: number | null;
    };

export async function toolQuote(
  ctx: ToolContext,
  input: { vehicleId: string; startsAt: Date | null; endsAt: Date | null; enquiryId?: string | null; delivery?: boolean; persist?: boolean },
): Promise<QuoteAnswer> {
  if (!input.startsAt || !input.endsAt) return { known: false, reason: "no_dates" };
  const vehicle = await getVehicle(ctx.db, ctx.tenantId, input.vehicleId);
  if (!vehicle) return { known: false, reason: "unknown_vehicle" };

  const days = rentalDays(input.startsAt, input.endsAt);
  if (days < vehicle.minDays) {
    return { known: false, reason: "below_minimum", detail: `${vehicle.make} ${vehicle.model} has a ${vehicle.minDays}-day minimum` };
  }

  const breakdown = await priceFor(ctx.db, ctx.tenantId, {
    vehicle, startsAt: input.startsAt, endsAt: input.endsAt, delivery: input.delivery ?? false,
  });
  const avail = await checkAvailability(ctx.db, ctx.tenantId, input.vehicleId, input.startsAt, input.endsAt);
  const availabilityConfirmed = avail.available && avail.authoritative;

  let quoteId: string | null = null;
  if (input.persist && input.enquiryId) {
    const q = await createQuote(ctx.db, ctx.tenantId, {
      enquiryId: input.enquiryId, vehicleId: input.vehicleId,
      startsAt: input.startsAt, endsAt: input.endsAt, delivery: input.delivery ?? false,
    });
    quoteId = q.id;
  }

  return {
    known: true, quoteId, vehicle, days,
    total: breakdown.total, deposit: breakdown.deposit, subtotal: breakdown.subtotal,
    vat: breakdown.vat, deliveryFee: breakdown.deliveryFee, currency: breakdown.currency,
    rateApplied: breakdown.rateApplied, availabilityConfirmed,
    includedKmPerDay: breakdown.includedKmPerDay,
  };
}

export async function toolRentalRules(ctx: ToolContext) {
  const rules = await getRules(ctx.db, ctx.tenantId);
  return {
    known: true as const,
    minAge: rules.minAge,
    requiredDocuments: rules.requiredDocuments,
    paymentMethods: rules.paymentMethods,
    maxDrivers: rules.maxDrivers,
    supportHours: rules.supportHours,
    depositDefault: rules.depositDefault,
  };
}

export async function toolAvailableOn(ctx: ToolContext, startsAt: Date, endsAt: Date, limit = 4) {
  const free = await findAvailableVehicles(ctx.db, ctx.tenantId, startsAt, endsAt);
  return {
    known: true as const,
    vehicles: free.slice(0, limit).map((v) => ({ id: v.id, label: `${v.make} ${v.model}`, dailyRate: v.dailyRate })),
    authoritative: free[0]?.authoritative ?? false,
  };
}

export function money(minor: number, currency = "AED"): string {
  return formatMoney(minor, currency);
}

import { z } from "zod";
import { assessAvailability, explainVerdict } from "../core/availability/availability.engine.js";
import { formatMoney, toMajor } from "../core/money.js";
import { AiDisabledError, NotFoundError, VehicleContendedError, VehicleUnavailableError, isAppError } from "../core/errors.js";
import type { Logger } from "../core/logger.js";
import { evaluateQualification, minimumAgeFor } from "../core/qualification.js";
import type { TenantProfile } from "../core/types.js";
import type { TenantDatabase } from "../db/tenant-context.js";
import type { CustomerService } from "../services/customer.service.js";
import type { QuoteService } from "../services/quote.service.js";
import type { ReservationService } from "../services/reservation.service.js";
import type { VehicleService } from "../services/vehicle.service.js";

/**
 * ===========================================================================
 * TOOL EXECUTION: WHERE GROUNDING ACTUALLY HAPPENS
 * ===========================================================================
 *
 * Every tool call the model makes lands here, and every one of them is
 * validated, executed against the database, and answered with figures the
 * pricing engine produced. The model's arguments are treated as what they are:
 * an untrusted parse of a customer's sentence.
 *
 * Two things this file deliberately does.
 *
 * It validates with zod before touching anything. A model that emits
 * startAt: "next Friday" gets a clean tool error telling it to resolve the
 * date, not a database query with a rubbish parameter.
 *
 * It returns money in two forms: the integer minor amount, and a formatted
 * string. The formatted string exists so the model has something correct to
 * copy into a sentence and no reason to do arithmetic on the integer.
 */

const searchInput = z.object({
  categoryCode: z.string().max(64).optional(),
  make: z.string().max(64).optional(),
  maxDailyRateMinor: z.number().int().positive().optional(),
  limit: z.number().int().min(1).max(10).optional(),
});

const availabilityInput = z.object({
  vehicleId: z.string().uuid("vehicleId must be an id returned by SEARCH_VEHICLES"),
  startAt: z.string().datetime({ offset: true }),
  endAt: z.string().datetime({ offset: true }),
  deliveryRequested: z.boolean().optional(),
  addOnCodes: z.array(z.string().max(64)).max(10).optional(),
});

const holdInput = z.object({
  quoteId: z.string().uuid(),
  confirmedByCustomer: z.boolean(),
});

export interface ToolContext {
  tenant: TenantProfile;
  conversationId: string;
  customerId: string;
}

export interface ToolOutcome {
  content: string;
  isError: boolean;
  /** Set when the tool decided a human must take this conversation over. */
  escalation?: { reason: "AGE_BELOW_MINIMUM" | "CUSTOM_RATE_REQUEST" | "INVENTORY_CONFLICT"; summary: string };
  /** Ids the pipeline records against the conversation. */
  quoteId?: string;
  reservationId?: string;
}

export class ToolExecutor {
  constructor(
    private readonly db: TenantDatabase,
    private readonly vehicles: VehicleService,
    private readonly quotes: QuoteService,
    private readonly reservations: ReservationService,
    private readonly customers: CustomerService,
    private readonly log: Logger,
  ) {}

  async execute(name: string, input: Record<string, unknown>, context: ToolContext): Promise<ToolOutcome> {
    try {
      switch (name) {
        case "SEARCH_VEHICLES":
          return await this.searchVehicles(input, context);
        case "CHECK_AVAILABILITY":
          return await this.checkAvailability(input, context);
        case "CREATE_HOLD":
          return await this.createHold(input, context);
        default:
          return { content: `No such tool: ${name}`, isError: true };
      }
    } catch (err) {
      // Tool errors are returned to the model as text rather than thrown,
      // because a model that is told "that car is already booked" recovers
      // gracefully, and a model whose tool call vanished into an exception
      // tends to invent an answer instead.
      if (isAppError(err)) {
        this.log.warn({ err, tool: name, code: err.code }, "tool call failed");
        return { content: err.expose ? err.message : "That did not work. Tell the customer plainly and offer to check something else.", isError: true };
      }
      this.log.error({ err, tool: name }, "tool call errored");
      return { content: "Something went wrong on our side. Apologise briefly and say a colleague will follow up.", isError: true };
    }
  }

  private async searchVehicles(raw: Record<string, unknown>, context: ToolContext): Promise<ToolOutcome> {
    const parsed = searchInput.safeParse(raw);
    if (!parsed.success) return invalid(parsed.error.issues);

    const criteria = {
      ...(parsed.data.categoryCode !== undefined ? { categoryCode: parsed.data.categoryCode } : {}),
      ...(parsed.data.make !== undefined ? { make: parsed.data.make } : {}),
      ...(parsed.data.maxDailyRateMinor !== undefined ? { maxDailyRateMinor: parsed.data.maxDailyRateMinor } : {}),
      limit: parsed.data.limit ?? 5,
    };

    const found = await this.db.withTenant(context.tenant.clientId, async (tx) => this.vehicles.search(tx, criteria));

    if (found.length === 0) {
      return {
        content: JSON.stringify({
          vehicles: [],
          note: "Nothing in the fleet matches. Say so plainly and ask what would work instead. Do not invent a car.",
        }),
        isError: false,
      };
    }

    return {
      content: JSON.stringify({
        vehicles: found.map((v) => ({
          vehicleId: v.id,
          make: v.make,
          model: v.model,
          year: v.year,
          categoryCode: v.categoryCode,
          // Published rates only. The actual quote comes from CHECK_AVAILABILITY,
          // which is the only thing that knows the bracket and the season.
          dailyRate: formatMoney(v.dailyRateMinor, context.tenant.currency),
          dailyRateMinor: v.dailyRateMinor,
          minimumDriverAge: minimumAgeFor(context.tenant, v.categoryCode),
        })),
        note: "These rates are the published daily rate before any bracket, season, delivery or VAT. Call CHECK_AVAILABILITY for the real total.",
      }),
      isError: false,
    };
  }

  private async checkAvailability(raw: Record<string, unknown>, context: ToolContext): Promise<ToolOutcome> {
    const parsed = availabilityInput.safeParse(raw);
    if (!parsed.success) return invalid(parsed.error.issues);

    const startAt = new Date(parsed.data.startAt);
    const endAt = new Date(parsed.data.endAt);
    if (endAt.getTime() <= startAt.getTime()) {
      return { content: "The return time must be after the collection time. Ask the customer to confirm the dates.", isError: true };
    }

    const { tenant } = context;

    // --- The age gate, before a price is ever produced ---------------------
    // Quoting an under age driver and withdrawing it afterwards is worse than
    // never quoting, so the check happens here rather than at booking time.
    const customer = await this.db.withTenant(tenant.clientId, async (tx) =>
      tx.customer.findUnique({ where: { id: context.customerId } }),
    );
    const vehicle = await this.db.withTenant(tenant.clientId, async (tx) =>
      this.vehicles.getSnapshot(tx, parsed.data.vehicleId),
    );

    if (customer) {
      const qualification = evaluateQualification(
        tenant,
        {
          ageYears: this.customers.ageAt(customer),
          licenceYears: licenceYears(customer.licenceIssuedOn),
          documentsVerified: customer.documentsVerifiedAt !== null,
          blocked: customer.blocked,
        },
        vehicle.categoryCode,
      );

      if (qualification.failures.includes("AGE_BELOW_MINIMUM")) {
        return {
          content: `This customer is under the minimum age of ${qualification.minimumAgeApplied} for this category. Do not quote. A colleague is picking this up.`,
          isError: true,
          escalation: {
            reason: "AGE_BELOW_MINIMUM",
            summary: `Driver is under the ${qualification.minimumAgeApplied} minimum for ${vehicle.make} ${vehicle.model}`,
          },
        };
      }
    }

    // --- Availability, then price. Never the other way round ---------------
    const claims = await this.db.withTenant(tenant.clientId, async (tx) =>
      this.vehicles.claimsFor(tx, vehicle.id, startAt, endAt),
    );
    const verdict = assessAvailability(vehicle, claims, { startAt, endAt }, new Date());

    if (!verdict.available) {
      return {
        content: JSON.stringify({
          available: false,
          reason: explainVerdict(verdict, vehicle),
          note: "Tell the customer plainly and offer to check another car or other dates.",
        }),
        isError: false,
      };
    }

    const { quote, breakdown } = await this.quotes.create({
      tenant,
      vehicleId: vehicle.id,
      customerId: context.customerId,
      conversationId: context.conversationId,
      startAt,
      endAt,
      deliveryRequested: parsed.data.deliveryRequested ?? false,
      addOns: (parsed.data.addOnCodes ?? []).map((code) => ({ code })),
    });

    // Everything the model needs to write a sentence, and nothing it needs to
    // compute. The formatted strings are what it should copy.
    return {
      quoteId: quote.id,
      isError: false,
      content: JSON.stringify({
        available: true,
        quoteId: quote.id,
        vehicle: `${vehicle.year} ${vehicle.make} ${vehicle.model}`,
        durationDays: breakdown.durationDays,
        rateBasis: `${breakdown.rateBracket.toLowerCase()} rate`,
        lines: {
          base: formatMoney(breakdown.adjustedBaseMinor, breakdown.currency),
          delivery: breakdown.deliveryFeeMinor > 0 ? formatMoney(breakdown.deliveryFeeMinor, breakdown.currency) : null,
          addOns: breakdown.addOnsTotalMinor > 0 ? formatMoney(breakdown.addOnsTotalMinor, breakdown.currency) : null,
          vat: formatMoney(breakdown.vatMinor, breakdown.currency),
        },
        total: formatMoney(breakdown.totalMinor, breakdown.currency),
        totalMinor: breakdown.totalMinor,
        totalMajor: toMajor(breakdown.totalMinor),
        deposit: breakdown.depositMinor > 0 ? formatMoney(breakdown.depositMinor, breakdown.currency) : null,
        quoteValidUntil: quote.expiresAt.toISOString(),
        note: "Quote these figures exactly as written. The total already includes VAT. Do not recalculate anything.",
      }),
    };
  }

  private async createHold(raw: Record<string, unknown>, context: ToolContext): Promise<ToolOutcome> {
    const parsed = holdInput.safeParse(raw);
    if (!parsed.success) return invalid(parsed.error.issues);

    if (!parsed.data.confirmedByCustomer) {
      return {
        content: "The customer has not actually agreed yet. Ask them to confirm before holding the car.",
        isError: true,
      };
    }

    const { tenant } = context;
    const quote = await this.quotes.findClaimable(tenant, parsed.data.quoteId);
    if (!quote) {
      return {
        content: "That quote has expired or was already used. Offer to re-check the dates and quote again.",
        isError: true,
      };
    }

    try {
      const reservation = await this.reservations.createHold({
        tenant,
        vehicleId: quote.vehicleId,
        customerId: context.customerId,
        quoteId: quote.id,
        conversationId: context.conversationId,
        startAt: quote.startAt,
        endAt: quote.endAt,
        totalMinor: quote.totalMinor,
        vatMinor: quote.vatMinor,
        depositMinor: quote.depositMinor,
        deliveryRequired: quote.deliveryRequired,
      });

      await this.quotes.markAccepted(tenant, quote.id);

      return {
        reservationId: reservation.id,
        isError: false,
        content: JSON.stringify({
          held: true,
          reference: reservation.reference,
          holdExpiresAt: reservation.holdExpiresAt?.toISOString(),
          total: formatMoney(reservation.totalMinor, reservation.currency),
          note: "The car is held, NOT booked. Give the reference, say how long the hold lasts, and explain that payment confirms it.",
        }),
      };
    } catch (err) {
      // Losing the race is an ordinary outcome on a busy Friday, and the
      // customer is still a customer. The model is told to pivot, not apologise.
      if (err instanceof VehicleContendedError) {
        return {
          content: "Another customer secured that car seconds ago. Say so honestly, apologise briefly, and offer the closest alternative straight away.",
          isError: true,
        };
      }
      if (err instanceof VehicleUnavailableError) {
        return { content: `${err.message} Offer an alternative.`, isError: true };
      }
      if (err instanceof NotFoundError || err instanceof AiDisabledError) throw err;
      throw err;
    }
  }
}

function invalid(issues: Array<{ path: Array<string | number>; message: string }>): ToolOutcome {
  return {
    content: `Those arguments are not valid: ${issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}. Fix them and try again.`,
    isError: true,
  };
}

/** Whole years since a licence was issued, or null when unknown. */
function licenceYears(issuedOn: Date | null): number | null {
  if (!issuedOn) return null;
  const ms = Date.now() - issuedOn.getTime();
  return Math.floor(ms / (365.25 * 24 * 3_600_000));
}

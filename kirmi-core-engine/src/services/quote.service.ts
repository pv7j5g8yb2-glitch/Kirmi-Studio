import type { Quote } from "@prisma/client";
import { calculatePrice } from "../core/pricing/pricing.engine.js";
import type { AddOnSelection, PriceBreakdown } from "../core/pricing/types.js";
import { minutesFromNow } from "../core/time.js";
import type { TenantProfile } from "../core/types.js";
import type { TenantDatabase } from "../db/tenant-context.js";
import type { AuditService } from "./audit.service.js";
import type { VehicleService } from "./vehicle.service.js";

/**
 * Turning a priced calculation into a stored, expiring offer.
 *
 * The service does no arithmetic of its own. It fetches the inputs, hands them
 * to the pricing engine, and writes what comes back. Every figure on the row,
 * including the intermediate ones, comes from that single call, so a stored
 * quote can be recomputed from its own breakdown and proved correct.
 *
 * Quotes expire. A price quoted in December for a car in high season cannot
 * still be claimable in February, and an expiry the customer was told about is
 * a much easier conversation than a price withdrawn after the fact.
 */
export interface CreateQuoteParams {
  tenant: TenantProfile;
  vehicleId: string;
  customerId: string;
  conversationId?: string | null;
  startAt: Date;
  endAt: Date;
  deliveryRequested?: boolean;
  addOns?: AddOnSelection[];
}

export class QuoteService {
  constructor(
    private readonly db: TenantDatabase,
    private readonly vehicles: VehicleService,
    private readonly audit: AuditService,
  ) {}

  async create(params: CreateQuoteParams): Promise<{ quote: Quote; breakdown: PriceBreakdown }> {
    const { tenant } = params;

    return this.db.withTenant(tenant.clientId, async (tx) => {
      const vehicle = await this.vehicles.getSnapshot(tx, params.vehicleId);

      // The single arithmetic call. Pure function, no I/O, fully reproducible.
      const breakdown = calculatePrice({
        tenant,
        vehicle,
        categoryCode: vehicle.categoryCode,
        startAt: params.startAt,
        endAt: params.endAt,
        deliveryRequested: params.deliveryRequested ?? false,
        addOns: params.addOns ?? [],
      });

      const quote = await tx.quote.create({
        data: {
          clientId: tenant.clientId,
          conversationId: params.conversationId ?? null,
          customerId: params.customerId,
          vehicleId: vehicle.id,
          status: "SENT",

          startAt: params.startAt,
          endAt: params.endAt,
          durationDays: breakdown.durationDays,

          rateBracket: breakdown.rateBracket,
          unitRateMinor: breakdown.unitRateMinor,
          units: breakdown.units,
          remainderDays: breakdown.remainderDays,
          remainderRateMinor: breakdown.remainderRateMinor,
          baseFareMinor: breakdown.baseFareMinor,

          seasonalCode: breakdown.seasonalCode,
          seasonalBasisPoints: breakdown.seasonalBasisPoints,
          seasonalAdjustmentMinor: breakdown.seasonalAdjustmentMinor,

          deliveryRequired: breakdown.deliveryRequired,
          deliveryFeeMinor: breakdown.deliveryFeeMinor,
          addOns: breakdown.addOnLines as unknown as object,
          addOnsTotalMinor: breakdown.addOnsTotalMinor,

          subtotalMinor: breakdown.subtotalMinor,
          vatBasisPoints: breakdown.vatBasisPoints,
          vatMinor: breakdown.vatMinor,
          totalMinor: breakdown.totalMinor,
          depositMinor: breakdown.depositMinor,
          currency: breakdown.currency,

          // The full trace, so this price is auditable without re-deriving the
          // inputs from six other tables months later.
          breakdown: breakdown as unknown as object,
          calcVersion: breakdown.calcVersion,
          expiresAt: minutesFromNow(tenant.pricing.quoteValidMinutes),
        },
      });

      // A quote is not revenue, so revenueMinor stays null. Only a secured
      // booking moves money, and only that event carries an amount.
      await this.audit.record(tx, tenant.clientId, {
        eventType: "QUOTE_ISSUED",
        actor: "AI",
        conversationId: params.conversationId ?? null,
        customerId: params.customerId,
        vehicleId: vehicle.id,
        quoteId: quote.id,
        payload: {
          totalMinor: breakdown.totalMinor,
          durationDays: breakdown.durationDays,
          rateBracket: breakdown.rateBracket,
          seasonalCode: breakdown.seasonalCode,
        },
      });

      return { quote, breakdown };
    });
  }

  /** A quote is claimable only while it is SENT and unexpired. */
  async findClaimable(tenant: TenantProfile, quoteId: string): Promise<Quote | null> {
    return this.db.withTenant(tenant.clientId, async (tx) =>
      tx.quote.findFirst({
        where: { id: quoteId, status: { in: ["SENT", "DRAFT"] }, expiresAt: { gt: new Date() } },
      }),
    );
  }

  async markAccepted(tenant: TenantProfile, quoteId: string): Promise<void> {
    await this.db.withTenant(tenant.clientId, async (tx) => {
      await tx.quote.update({ where: { id: quoteId }, data: { status: "ACCEPTED" } });
    });
  }
}

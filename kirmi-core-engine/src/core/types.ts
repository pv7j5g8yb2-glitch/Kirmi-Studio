import type {
  AddOnDefinition,
  EscalationTarget,
  FollowUpPolicy,
  MessageTemplate,
  OpeningHours,
  SeasonalModifier,
} from "../config/tenant-schema.js";
import type { Minor } from "./money.js";

/**
 * The shapes the stateless core works in.
 *
 * Nothing here is a Prisma type. The pricing and availability engines are pure
 * functions over plain data: no database handle, no clock of their own, no
 * network. That is what lets the reservation race be tested deterministically
 * and what stops a schema change quietly altering a price.
 */

export type ClientLifecycle = "ONBOARDING" | "ACTIVE" | "SUSPENDED" | "CHURNED";
export type FeeModelKind = "RETAINER" | "COMMISSION" | "HYBRID";
export type RateBracketKind = "DAILY" | "WEEKLY" | "MONTHLY";

/**
 * The resolved, validated view of one tenant. Built from clients +
 * client_configurations, then cached hot in Redis.
 *
 * Note what is NOT here: no Meta app secret, no payment key, no Twilio token.
 * Secrets are fetched and decrypted on the one code path that needs them. The
 * object that gets cached, logged and passed around cannot leak a credential
 * because it never held one.
 */
export interface TenantProfile {
  clientId: string;
  slug: string;
  legalName: string;
  tradingName: string;
  currency: string;
  timezone: string;
  status: ClientLifecycle;

  languages: {
    supported: string[];
    default: string;
  };

  /** Hard gates. Evaluated in code, never delegated to the model. */
  qualification: {
    minimumDriverAge: number;
    minimumLicenceYears: number;
    requiredDocuments: string[];
    categoryAgeOverrides: Record<string, number>;
  };

  pricing: {
    vatBasisPoints: number;
    weeklyThresholdDays: number;
    monthlyThresholdDays: number;
    deliveryFeeMinor: Minor;
    freeDeliveryThresholdDays: number | null;
    defaultDepositMinor: Minor;
    seasonalModifiers: SeasonalModifier[];
    addOnCatalogue: AddOnDefinition[];
    quoteValidMinutes: number;
    holdTtlMinutes: number;
    /** The longer window that applies once a payment link has gone out. */
    paymentHoldMinutes: number;
  };

  openingHours: OpeningHours;

  escalation: {
    targets: EscalationTarget[];
    rules: Record<string, "IMMEDIATE" | "BATCHED" | "SILENT">;
  };

  /** Kirmi Studio's own commercial terms with this client. */
  billing: {
    feeModel: FeeModelKind;
    retainerMinor: Minor;
    commissionBasisPoints: number;
  };

  agent: {
    displayName: string | null;
    toneNotes: string | null;
    systemPromptExtra: string | null;
  };

  /**
   * Reaching a customer who has not written first.
   *
   * Separate from `agent` because none of this is personality: these are the
   * only messages Meta permits outside the 24 hour window, and sending one that
   * is not on this list is a guaranteed refusal rather than a stylistic choice.
   */
  proactive: {
    templates: MessageTemplate[];
    followUp: FollowUpPolicy;
    /** SMS costs money per segment, so it is opt in per client. */
    smsFallbackEnabled: boolean;
    vehiclePhotosEnabled: boolean;
  };

  /** Non secret channel identifiers, safe to cache and log. */
  channels: {
    metaPhoneNumberId: string | null;
    metaBusinessAccountId: string | null;
    instagramScopedPageId: string | null;
    twilioAccountSid: string | null;
    twilioNumber: string | null;
  };
}

/** Per tenant credentials, decrypted on demand and never cached in clear. */
export interface TenantSecrets {
  metaAppSecret: string | null;
  metaVerifyToken: string | null;
  /** Sends as the client's business. The most damaging credential in the row. */
  metaAccessToken: string | null;
  metaGraphApiVersion: string | null;
  twilioAuthToken: string | null;
  paymentSecretKey: string | null;
}

/** The minimum a vehicle must expose for the core engines to reason about it. */
export interface VehicleSnapshot {
  id: string;
  categoryId: string;
  categoryCode: string;
  make: string;
  model: string;
  year: number;
  plateNumber: string;
  dailyRateMinor: Minor;
  weeklyRateMinor: Minor | null;
  monthlyRateMinor: Minor | null;
  depositMinor: Minor | null;
  status: "AVAILABLE" | "ON_HIRE" | "RESERVED" | "MAINTENANCE" | "RETIRED";
  active: boolean;
  offRoadUntil: Date | null;
}

export interface RentalWindow {
  startAt: Date;
  endAt: Date;
}

/** An existing claim on a vehicle, as the availability engine sees it. */
export interface ExistingClaim extends RentalWindow {
  reservationId: string;
  status: "HOLD" | "CONFIRMED" | "CANCELLED" | "COMPLETED" | "EXPIRED";
}

import { z } from "zod";
import { BASIS_POINTS_SCALE } from "./constants.js";

/**
 * The contract for every JSON column in client_configurations.
 *
 * JSON columns are how a client is configured without a migration. The cost of
 * that flexibility is that Postgres will happily store nonsense, so nothing in
 * this engine reads a raw config blob. It is parsed through these schemas on
 * the way out of the database, once, and cached. A malformed config then fails
 * loudly at load with the client's name attached, rather than three layers deep
 * inside a price calculation at 9pm on a Friday.
 */

const timeOfDay = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, "expected HH:MM in 24 hour time");

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD");

export const WEEKDAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
export type Weekday = (typeof WEEKDAYS)[number];

const openingWindow = z
  .object({ open: timeOfDay, close: timeOfDay })
  .refine((w) => w.close > w.open, { message: "close must be after open" });

/**
 * Opening hours are advisory, not a gate. A luxury rental desk that answers a
 * 2am enquiry before its competitor opens is the entire product, so these hours
 * shape what the reply SAYS ("our delivery team starts at 8"), never whether a
 * reply is sent.
 */
export const openingHoursSchema = z.object({
  mon: z.array(openingWindow).default([]),
  tue: z.array(openingWindow).default([]),
  wed: z.array(openingWindow).default([]),
  thu: z.array(openingWindow).default([]),
  fri: z.array(openingWindow).default([]),
  sat: z.array(openingWindow).default([]),
  sun: z.array(openingWindow).default([]),
  /** Dated overrides: public holidays, Eid, a closed showroom. */
  exceptions: z
    .array(z.object({ date: isoDate, closed: z.boolean().default(true), windows: z.array(openingWindow).default([]) }))
    .default([]),
});
export type OpeningHours = z.infer<typeof openingHoursSchema>;

/**
 * Seasonal pricing. Expressed in basis points so the arithmetic stays integral:
 * 12_500 is a 25% high season uplift, 9_000 is a 10% off season discount.
 * Windows are inclusive of both ends and matched against the rental START date
 * in the client's own timezone, which is how a rental desk quotes.
 */
export const seasonalModifierSchema = z.object({
  code: z.string().min(1),
  label: z.string().optional(),
  startsOn: isoDate,
  endsOn: isoDate,
  multiplierBasisPoints: z.number().int().min(1).max(10 * BASIS_POINTS_SCALE),
  /** Narrow a modifier to certain categories, e.g. only supercars in December. */
  categoryCodes: z.array(z.string()).default([]),
});
export type SeasonalModifier = z.infer<typeof seasonalModifierSchema>;
export const seasonalModifiersSchema = z.array(seasonalModifierSchema);

/** Extras a customer can add. PER_DAY multiplies by duration, RENTAL is flat. */
export const addOnSchema = z.object({
  code: z.string().min(1),
  label: z.string().min(1),
  unit: z.enum(["PER_DAY", "PER_RENTAL"]).default("PER_RENTAL"),
  priceMinor: z.number().int().min(0),
  /** Some add-ons are not optional for some categories, e.g. a second driver fee. */
  mandatoryForCategoryCodes: z.array(z.string()).default([]),
});
export type AddOnDefinition = z.infer<typeof addOnSchema>;
export const addOnCatalogueSchema = z.array(addOnSchema);

/** Stricter age gates per category: { "SUPERCAR": 30 }. */
export const categoryAgeOverridesSchema = z.record(z.string(), z.number().int().min(16).max(99));

/** Where a human exception is delivered. */
export const escalationTargetSchema = z.object({
  kind: z.enum(["whatsapp", "email", "webhook", "socket"]),
  target: z.string().min(1),
  /** ALWAYS pages at 3am. BUSINESS_HOURS waits for the desk to open. */
  hours: z.enum(["ALWAYS", "BUSINESS_HOURS"]).default("ALWAYS"),
  reasons: z.array(z.string()).default([]),
});
export type EscalationTarget = z.infer<typeof escalationTargetSchema>;
export const escalationTargetsSchema = z.array(escalationTargetSchema);

/** Per reason urgency. Anything absent falls back to IMMEDIATE: when in doubt
 *  about a failed customer, wake a person. */
export const escalationRulesSchema = z.record(z.string(), z.enum(["IMMEDIATE", "BATCHED", "SILENT"]));

/** Payment credentials. Secrets are stored encrypted and never logged. */
export const paymentAccessKeysSchema = z.object({
  provider: z.enum(["stripe", "telr", "network", "manual"]).default("manual"),
  publishableKey: z.string().optional(),
  secretKeyEncrypted: z.string().optional(),
  webhookSecretEncrypted: z.string().optional(),
  /** Fraction of the total taken up front, in basis points. 10_000 is pay in full. */
  depositCaptureBasisPoints: z.number().int().min(0).max(BASIS_POINTS_SCALE).default(BASIS_POINTS_SCALE),
});
export type PaymentAccessKeys = z.infer<typeof paymentAccessKeysSchema>;

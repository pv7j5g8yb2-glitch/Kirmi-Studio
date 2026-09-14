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

/**
 * ===========================================================================
 * PROACTIVE MESSAGING
 * ===========================================================================
 */

export const FOLLOW_UP_KINDS = ["QUOTE_NO_REPLY", "HOLD_EXPIRING", "MISSED_CALL", "REACTIVATION"] as const;
export type FollowUpKindCode = (typeof FOLLOW_UP_KINDS)[number];

/**
 * The placeholders a template may ask for.
 *
 * An enum rather than a free string, because a typo here does not fail at
 * config load, it fails in a customer's chat: WhatsApp renders an unresolved
 * parameter as an empty string, so `{{2}}` quietly becomes "Your  is still
 * available". Naming the permitted set means a bad config is rejected at load
 * with the client's name attached, which is the whole point of this file.
 */
export const TEMPLATE_PARAMS = [
  "customerName",
  "businessName",
  "vehicleName",
  "quoteTotal",
  "reference",
  "holdExpiry",
  "startDate",
] as const;
export type TemplateParam = (typeof TEMPLATE_PARAMS)[number];

/**
 * One approved WhatsApp template.
 *
 * `name` and `language` must match what Meta approved exactly. There is no way
 * to verify that from here, so a rejected send is logged with both, which is
 * the fastest route to discovering that someone submitted `quote_followup` and
 * configured `quote_follow_up`.
 */
export const messageTemplateSchema = z.object({
  kind: z.enum(FOLLOW_UP_KINDS),
  name: z.string().min(1),
  language: z.string().min(2).default("en"),
  /** In the order Meta's {{1}}, {{2}} placeholders appear in the approved body. */
  bodyParams: z.array(z.enum(TEMPLATE_PARAMS)).default([]),
  /** Fallback wording used when the service window is still open, where a plain
   *  message reads far better than a template. */
  freeFormBody: z.string().optional(),
});
export type MessageTemplate = z.infer<typeof messageTemplateSchema>;
export const messageTemplatesSchema = z.array(messageTemplateSchema);

/** When to chase, how often, and when to stop. */
export const followUpRuleSchema = z.object({
  kind: z.enum(FOLLOW_UP_KINDS),
  enabled: z.boolean().default(true),
  /** From the triggering event: the quote being sent, the call being missed. */
  delayMinutes: z.number().int().min(1),
  /** Chasing a third time is not persistence, it is harassment, and it is the
   *  fastest way to have a client's number blocked by Meta for quality. */
  maxAttempts: z.number().int().min(1).max(3).default(1),
  /** Gap before the next attempt, when maxAttempts is above one. */
  repeatAfterMinutes: z.number().int().min(30).optional(),
});
export type FollowUpRule = z.infer<typeof followUpRuleSchema>;

/**
 * Quiet hours apply to messages the engine starts, never to replies.
 *
 * Answering a customer at 03:18 is the product. Ringing their phone at 03:18
 * to say a quote is still available is a complaint and a block. The sweeper
 * defers a due follow up to the end of the quiet window rather than dropping it.
 */
export const followUpPolicySchema = z.object({
  rules: z.array(followUpRuleSchema).default([]),
  quietHours: z
    .object({ from: timeOfDay, to: timeOfDay })
    .nullable()
    .default({ from: "21:30", to: "08:30" }),
});
export type FollowUpPolicy = z.infer<typeof followUpPolicySchema>;

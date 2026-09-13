import type { OpeningHours } from "./tenant-schema.js";

/**
 * What a new client looks like before anyone configures anything.
 *
 * These are onboarding defaults, applied once at insert time, not runtime
 * fallbacks. A client row that is missing a value is a data bug and should
 * surface as one, rather than silently inheriting a number from here months
 * later and quietly pricing somebody's Urus wrong.
 */

/** A UAE rental desk: open every day, Friday shortened around prayers. */
export const DEFAULT_OPENING_HOURS: OpeningHours = {
  mon: [{ open: "09:00", close: "21:00" }],
  tue: [{ open: "09:00", close: "21:00" }],
  wed: [{ open: "09:00", close: "21:00" }],
  thu: [{ open: "09:00", close: "22:00" }],
  fri: [{ open: "14:30", close: "22:00" }],
  sat: [{ open: "10:00", close: "22:00" }],
  sun: [{ open: "10:00", close: "20:00" }],
  exceptions: [],
};

export const TENANT_DEFAULTS = {
  currency: "AED",
  timezone: "Asia/Dubai",
  supportedLanguages: ["en", "ar", "ru"] as string[],
  defaultLanguage: "en",

  /** UAE VAT is 5%. Stored per client because a US tenant is not on 5%, and a
   *  rate change is a config edit rather than a release. */
  vatBasisPoints: 500,

  minimumDriverAge: 25,
  minimumLicenceYears: 1,
  requiredDocuments: ["passport", "driving_licence", "visa_or_entry_stamp"] as string[],

  weeklyThresholdDays: 7,
  monthlyThresholdDays: 28,

  deliveryFeeMinor: 0,
  defaultDepositMinor: 0,
  quoteValidMinutes: 120,
  holdTtlMinutes: 30,

  /** Kirmi bills roughly EUR 1,200 to EUR 4,000 a month depending on size, so
   *  there is no platform wide number. Zero here forces the deal to be entered
   *  deliberately at onboarding rather than inherited by accident. */
  retainerMinor: 0,
  commissionBasisPoints: 0,
} as const;

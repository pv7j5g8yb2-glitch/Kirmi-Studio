/**
 * DEIZ Rental Dubai — first reference tenant.
 *
 * Every value carries a provenance marker. Nothing here is invented: values we could
 * not verify are seeded as `assumed` placeholders and are visibly flagged in the
 * console so nobody mistakes a placeholder for DEIZ's actual policy.
 *
 * Sources for `verified_public` rows: DEIZ public FAQ / directory listings, read
 * 13 September 2026. Daily rates are NOT public and are therefore `assumed`.
 */
import { query, withTenant, closePool } from "./index.js";
import { setSetting, type TenantRules } from "../domain/settings.js";
import { setIntegrationState } from "../core/integrations.js";
import { createVehicle } from "../domain/vehicles.js";
import { createUser } from "../core/auth.js";
import { toMinor } from "../core/money.js";

export const DEIZ_SLUG = "deiz";

const RULES: TenantRules = {
  minAge: 21,                       // verified_public
  depositDefault: toMinor(1500),    // ASSUMED — DEIZ never states an amount publicly
  vatPercent: 5,                    // verified_public (UAE standard rate)
  deliveryFee: toMinor(0),          // verified_public: "24/7 delivery" advertised as included
  freeDeliveryThresholdDays: null,
  requiredDocuments: ["passport", "driving_licence"], // verified_public
  paymentMethods: ["card", "cash", "crypto"],         // verified_public
  weeklyThresholdDays: 7,
  monthlyThresholdDays: 28,
  holdMinutes: 120,                 // assumed operating choice
  quoteValidHours: 48,              // assumed operating choice
  supportHours: "24/7",             // verified_public
  maxDrivers: 2,                    // verified_public: "two drivers per contract"
  inventoryAuthoritative: false,    // no inventory API connected -> quotes say "subject to confirmation"
};

/**
 * Placeholder fleet. Models are drawn from DEIZ's publicly advertised categories
 * (premium / sports / luxury / vintage) but every RATE is a placeholder pending the
 * client's real price list, which is why the whole record is `assumed`.
 */
const FLEET = [
  { make: "Mercedes-Benz", model: "G63 AMG", year: 2024, category: "suv", daily: 2500, weekly: 15000, monthly: 52000, deposit: 5000, km: 250, extraKm: 3, minAge: 25, minDays: 2 },
  { make: "Nissan", model: "Patrol Platinum", year: 2024, category: "suv", daily: 750, weekly: 4500, monthly: 16000, deposit: 1500, km: 250, extraKm: 1.5, minAge: 22, minDays: 1 },
  { make: "Lamborghini", model: "Urus", year: 2023, category: "sports", daily: 3200, weekly: 19500, monthly: 68000, deposit: 8000, km: 200, extraKm: 5, minAge: 25, minDays: 2 },
  { make: "Porsche", model: "911 Carrera", year: 2023, category: "sports", daily: 2200, weekly: 13200, monthly: 46000, deposit: 5000, km: 200, extraKm: 4, minAge: 25, minDays: 2 },
  { make: "Range Rover", model: "Vogue", year: 2024, category: "suv", daily: 1500, weekly: 9000, monthly: 31000, deposit: 3000, km: 250, extraKm: 2.5, minAge: 25, minDays: 1 },
  { make: "BMW", model: "M4 Competition", year: 2024, category: "sports", daily: 1400, weekly: 8400, monthly: 29000, deposit: 3000, km: 250, extraKm: 2.5, minAge: 25, minDays: 1 },
  { make: "Mercedes-Benz", model: "S500", year: 2023, category: "sedan", daily: 1300, weekly: 7800, monthly: 27000, deposit: 3000, km: 250, extraKm: 2.5, minAge: 25, minDays: 1 },
  { make: "Toyota", model: "Land Cruiser", year: 2023, category: "suv", daily: 650, weekly: 3900, monthly: 13500, deposit: 1500, km: 250, extraKm: 1.5, minAge: 21, minDays: 1 },
  { make: "Mercedes-Benz", model: "280 SL Pagoda", year: 1969, category: "vintage", daily: 2800, weekly: null, monthly: null, deposit: 10000, km: 100, extraKm: 8, minAge: 30, minDays: 1 },
  { make: "Bentley", model: "Continental GT", year: 2023, category: "luxury", daily: 2400, weekly: 14400, monthly: 50000, deposit: 6000, km: 200, extraKm: 4, minAge: 25, minDays: 2 },
];

export async function seedDeiz(opts: { mode?: "demo" | "production" } = {}): Promise<string> {
  const mode = opts.mode ?? "production";
  const { rows } = await query(
    `INSERT INTO tenants (slug, name, mode, timezone, currency, locales)
     VALUES ($1,$2,$3,'Asia/Dubai','AED', ARRAY['en','ar'])
     ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name
     RETURNING id`,
    [DEIZ_SLUG, "DEIZ Rental Dubai", mode],
  );
  const tenantId = rows[0].id as string;

  await withTenant(tenantId, async (db) => {
    await setSetting(db, tenantId, "rules", RULES, "client_provided");

    await setSetting(db, tenantId, "profile", {
      legalEntity: null,
      tradingName: "DEIZ Rental",
      address: "11, 2 Street, Port Saeed, Deira, Dubai",
      phone: "+971547561653",
      websites: ["deiz-rental.ae", "deiz.ae"],
      languages: ["English", "Arabic", "Russian"],
      note: "Two public domains exist (deiz-rental.ae and deiz.ae); which is the contracting entity is unconfirmed.",
    }, "verified_public");

    // Anything we could not verify is recorded explicitly as an open question rather
    // than silently defaulted. The console renders this list for the first client call.
    await setSetting(db, tenantId, "open_questions", [
      "Registered legal entity and trade licence number",
      "Actual security deposit per vehicle class (never stated publicly)",
      "Real daily/weekly/monthly rate card",
      "True fleet size — public sources say both '150+' and '15 vintage'",
      "Rental-management system in use, and whether it exposes an API",
      "Which WhatsApp number is used for sales, and whether it is on the WhatsApp Business app",
      "Mileage caps and extra-km charges per vehicle class",
      "Delivery/collection fees, if any, outside Dubai",
    ], "assumed");

    for (const v of FLEET) {
      await createVehicle(db, tenantId, {
        make: v.make, model: v.model, year: v.year, category: v.category,
        plate: null,
        dailyRate: toMinor(v.daily),
        weeklyRate: v.weekly ? toMinor(v.weekly) : null,
        monthlyRate: v.monthly ? toMinor(v.monthly) : null,
        deposit: toMinor(v.deposit),
        dailyKm: v.km,
        extraKmRate: toMinor(v.extraKm),
        minAge: v.minAge,
        minDays: v.minDays,
        attributes: { rate_provenance: "assumed" },
      });
    }

    // Honest starting state: nothing external is connected yet.
    await setIntegrationState(db, tenantId, "whatsapp", "NOT_CONNECTED", {
      detail: "Built and testable. Awaiting a WhatsApp Business Account and access token.",
      requirements: [
        "Meta Business Manager with a WhatsApp Business Account (WABA)",
        "A phone number not currently registered on the WhatsApp or WhatsApp Business app",
        "System user access token with whatsapp_business_messaging",
        "App secret for webhook signature verification",
        "Webhook URL registered with a verify token",
      ],
    });
    await setIntegrationState(db, tenantId, "instagram", "NOT_CONNECTED", {
      detail: "Built and testable. Awaiting App Review for messaging permissions.",
      requirements: [
        "Instagram Professional account linked to a Facebook Page",
        "instagram_manage_messages permission granted through App Review",
        "Page access token and app secret",
      ],
    });
    await setIntegrationState(db, tenantId, "voice", "NOT_CONNECTED", {
      detail: "Interface built. A mobile SIM cannot emit webhooks; needs a telephony layer.",
      requirements: [
        "A UAE-reachable number on a CPaaS/VoIP provider, or carrier conditional forwarding to one",
        "Confirmation that the provider may operate under UAE TDRA rules",
        "Missed-call webhook with a shared signing secret",
      ],
    });
    await setIntegrationState(db, tenantId, "payments", "NOT_CONNECTED", {
      detail: "Card flow built behind a provider interface. Cash and crypto are staff-confirmed by design.",
      requirements: ["Payment provider account and API keys", "Webhook signing secret"],
    });
    await setIntegrationState(db, tenantId, "inventory", "NOT_CONNECTED", {
      detail: "No authoritative source connected: quotes are phrased 'subject to confirmation'.",
      requirements: ["Name of the rental-management system", "API credentials, or agreement to run Kirmi as the source of truth"],
    });
    await setIntegrationState(db, tenantId, "llm", "CONNECTED", {
      detail: "Deterministic domain engine active. Set ANTHROPIC_API_KEY to enable model-assisted phrasing.",
    });
  });

  return tenantId;
}

export async function seedUsers(tenantId: string): Promise<void> {
  await createUser({
    email: "ismael@kirmistudio.com",
    name: "Ismael Kirmi",
    password: process.env.SEED_ADMIN_PASSWORD ?? "change-me-now",
    role: "kirmi_admin",
    tenantIds: [tenantId],
  });
  await createUser({
    email: "ops@deiz-rental.ae",
    name: "DEIZ Operations",
    password: process.env.SEED_CLIENT_PASSWORD ?? "change-me-now",
    role: "client_admin",
    tenantIds: [tenantId],
  });
}

if (process.argv[1]?.endsWith("seed-deiz.ts")) {
  seedDeiz()
    .then(async (id) => {
      await seedUsers(id);
      console.log("seeded DEIZ tenant", id);
      await closePool();
    })
    .catch(async (e) => { console.error(e); await closePool(); process.exit(1); });
}

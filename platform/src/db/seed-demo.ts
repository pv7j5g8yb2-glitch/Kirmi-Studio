/**
 * DEMO tenant. Completely isolated from production by tenant row + mode flag: the
 * scheduler hands demo tenants a mock provider, so a demo can never send a real
 * message or take a real payment however the environment is configured.
 */
import { query, withTenant, closePool } from "./index.js";
import { setSetting } from "../domain/settings.js";
import { setIntegrationState } from "../core/integrations.js";
import { createVehicle } from "../domain/vehicles.js";
import { upsertCustomer, openConversation } from "../domain/conversations.js";
import { ingestInbound } from "../engine/ingest.js";
import { createUser } from "../core/auth.js";
import { toMinor } from "../core/money.js";

export async function seedDemo(): Promise<string> {
  const { rows } = await query(
    `INSERT INTO tenants (slug, name, mode, timezone, currency, locales)
     VALUES ('demo','Demo Rental Co','demo','Asia/Dubai','AED', ARRAY['en','ar'])
     ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
  );
  const tenantId = rows[0].id as string;

  await withTenant(tenantId, async (db) => {
    await setSetting(db, tenantId, "rules", {
      minAge: 21, depositDefault: toMinor(1000), vatPercent: 5, deliveryFee: toMinor(150),
      freeDeliveryThresholdDays: 7, requiredDocuments: ["passport", "driving_licence"],
      paymentMethods: ["card", "cash"], holdMinutes: 120, quoteValidHours: 48,
      supportHours: "24/7", maxDrivers: 2, inventoryAuthoritative: true,
    }, "client_provided");
    await setSetting(db, tenantId, "channel:whatsapp", { accountId: "DEMO_PHONE_ID" }, "client_provided");

    const fleet = [
      { make: "Mercedes-Benz", model: "G63 AMG", cat: "suv", d: 2500, w: 15000, dep: 5000 },
      { make: "Nissan", model: "Patrol", cat: "suv", d: 750, w: 4500, dep: 1500 },
      { make: "Porsche", model: "911 Carrera", cat: "sports", d: 2200, w: 13200, dep: 5000 },
      { make: "Toyota", model: "Land Cruiser", cat: "suv", d: 650, w: 3900, dep: 1500 },
    ];
    for (const f of fleet) {
      await createVehicle(db, tenantId, {
        make: f.make, model: f.model, year: 2024, category: f.cat, plate: null,
        dailyRate: toMinor(f.d), weeklyRate: toMinor(f.w), monthlyRate: null,
        deposit: toMinor(f.dep), dailyKm: 250, extraKmRate: toMinor(2), minAge: 25, minDays: 1,
      });
    }

    for (const ch of ["whatsapp", "instagram", "voice", "payments"] as const) {
      await setIntegrationState(db, tenantId, ch, "CONNECTED", { detail: "Simulated for demonstration only — no real provider is contacted." });
    }
    await setIntegrationState(db, tenantId, "inventory", "CONNECTED", { detail: "Simulated authoritative inventory." });
    await setIntegrationState(db, tenantId, "llm", "CONNECTED", { detail: "Deterministic engine." });

    // A couple of realistic conversations so the console is not an empty shell.
    const scripts = [
      "Hi, how much for the G63 tomorrow for 3 days?",
      "What documents do I need?",
    ];
    let i = 0;
    for (const text of scripts) {
      await ingestInbound(db, tenantId, {
        channel: "whatsapp", providerMessageId: `demo-${Date.now()}-${i++}`,
        from: "971500000099", to: "DEMO_PHONE_ID", text, displayName: "Demo Customer",
        timestamp: new Date(), raw: {},
      }, { companyName: "Demo Rental Co" });
    }
    const cust = await upsertCustomer(db, tenantId, { phoneE164: "971500000098", displayName: "Aisha" });
    await openConversation(db, tenantId, cust.id, "instagram");
  });

  await createUser({
    email: "demo@kirmistudio.com", name: "Demo Operator",
    password: process.env.SEED_DEMO_PASSWORD ?? "demo-password-1",
    role: "client_admin", tenantIds: [tenantId],
  });
  return tenantId;
}

if (process.argv[1]?.endsWith("seed-demo.ts")) {
  seedDemo()
    .then(async (id) => { console.log("seeded demo tenant", id); await closePool(); })
    .catch(async (e) => { console.error(e); await closePool(); process.exit(1); });
}

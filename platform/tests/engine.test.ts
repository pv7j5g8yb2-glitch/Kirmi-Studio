import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { resetDb, createTenant, asTenant, daysFromNow } from "./helpers.js";
import { closePool } from "../src/db/index.js";
import { createVehicle } from "../src/domain/vehicles.js";
import { listMessages, takeOver } from "../src/domain/conversations.js";
import { ingestInbound } from "../src/engine/ingest.js";
import { understand, extractDates, extractVehicleHint, detectLocale, normaliseDigits } from "../src/engine/nlu.js";
import { computePrice } from "../src/domain/pricing.js";
import { DEFAULT_RULES } from "../src/domain/settings.js";
import { createUser } from "../src/core/auth.js";
import type { NormalisedInbound } from "../src/channels/types.js";
import { toMinor } from "../src/core/money.js";

function inbound(text: string, id = `wamid.${Math.random().toString(36).slice(2)}`): NormalisedInbound {
  return {
    channel: "whatsapp", providerMessageId: id, from: "971501234567", to: "PHONE_ID",
    text, displayName: "Omar", timestamp: new Date(), raw: {},
  };
}

describe("NLU", () => {
  it("converts Arabic-Indic digits so dates and durations parse in both scripts", () => {
    expect(normaliseDigits("٣ أيام")).toBe("3 أيام");
    const { days } = extractDates("أريد سيارة لمدة ٣ أيام");
    expect(days).toBe(3);
  });

  it("detects locale from script", () => {
    expect(detectLocale("how much for the G63")).toBe("en");
    expect(detectLocale("كم سعر الجي 63")).toBe("ar");
  });

  it("parses relative dates", () => {
    const now = new Date(Date.UTC(2026, 8, 13, 8, 0, 0));
    expect(extractDates("tomorrow for 3 days", now).startsAt?.toISOString().slice(0, 10)).toBe("2026-09-14");
    expect(extractDates("tomorrow for 3 days", now).days).toBe(3);
  });

  it("parses weekday, day-month and numeric dates day-first", () => {
    const now = new Date(Date.UTC(2026, 8, 13, 8, 0, 0)); // a Sunday
    expect(extractDates("friday for 2 days", now).startsAt?.getUTCDay()).toBe(5);
    expect(extractDates("12 October for a week", now).startsAt?.toISOString().slice(0, 10)).toBe("2026-10-12");
    expect(extractDates("12 October for a week", now).days).toBe(7);
    // 03/10 is 3 October, not 10 March
    expect(extractDates("03/10 for 2 days", now).startsAt?.toISOString().slice(0, 10)).toBe("2026-10-03");
  });

  it("converts weeks and months to days", () => {
    expect(extractDates("2 weeks").days).toBe(14);
    expect(extractDates("1 month").days).toBe(30);
  });

  it("pulls a vehicle hint out of a sentence and drops filler", () => {
    expect(extractVehicleHint("how much is the mercedes g63 for 3 days")).toContain("mercedes");
    expect(extractVehicleHint("hi")).toBeNull();
  });

  it("classifies intent", () => {
    expect(understand("hello").intent).toBe("greeting");
    expect(understand("how much for the urus?").intent).toBe("price_request");
    expect(understand("can I speak to a human").intent).toBe("handover_request");
    expect(understand("what documents do I need").intent).toBe("document_question");
  });
});

describe("pricing", () => {
  const vehicle = {
    id: "v", make: "M", model: "X", year: 2024, category: "suv", plate: null,
    dailyRate: toMinor(1000), weeklyRate: toMinor(6000), monthlyRate: toMinor(20000),
    deposit: toMinor(1500), dailyKm: 250, extraKmRate: toMinor(2), minAge: 25, minDays: 1,
    status: "active" as const, attributes: {},
  };
  const rules = { ...DEFAULT_RULES, vatPercent: 5 };

  it("charges the daily rate for short hires and adds VAT", () => {
    const p = computePrice({ vehicle, startsAt: daysFromNow(1), endsAt: daysFromNow(4), rules });
    expect(p.days).toBe(3);
    expect(p.rateApplied).toBe("daily");
    expect(p.subtotal).toBe(toMinor(3000));
    expect(p.vat).toBe(toMinor(150));
    expect(p.total).toBe(toMinor(3150));
  });

  it("falls to the weekly rate and never charges more than the daily equivalent", () => {
    const p = computePrice({ vehicle, startsAt: daysFromNow(1), endsAt: daysFromNow(11), rules });
    expect(p.days).toBe(10);
    expect(p.rateApplied).toBe("weekly");
    // 1 week + 3 days = 6000 + 3000, cheaper than 10 x 1000
    expect(p.subtotal).toBe(toMinor(9000));
    expect(p.subtotal).toBeLessThan(vehicle.dailyRate * 10);
  });

  it("uses the monthly rate for long hires", () => {
    const p = computePrice({ vehicle, startsAt: daysFromNow(1), endsAt: daysFromNow(31), rules });
    expect(p.rateApplied).toBe("monthly");
    expect(p.subtotal).toBe(toMinor(20000) + toMinor(2000)); // 28d + 2d
  });

  it("keeps money in integers with no floating point drift", () => {
    const odd = { ...vehicle, dailyRate: 33_333 };
    const p = computePrice({ vehicle: odd, startsAt: daysFromNow(1), endsAt: daysFromNow(4), rules });
    expect(Number.isInteger(p.subtotal)).toBe(true);
    expect(Number.isInteger(p.vat)).toBe(true);
    expect(p.total).toBe(p.subtotal + p.vat);
  });

  it("waives delivery past the tenant's threshold", () => {
    const r = { ...rules, deliveryFee: toMinor(100), freeDeliveryThresholdDays: 7 };
    const short = computePrice({ vehicle, startsAt: daysFromNow(1), endsAt: daysFromNow(3), delivery: true, rules: r });
    const long = computePrice({ vehicle, startsAt: daysFromNow(1), endsAt: daysFromNow(9), delivery: true, rules: r });
    expect(short.deliveryFee).toBe(toMinor(100));
    expect(long.deliveryFee).toBe(0);
  });
});

describe("conversation engine", () => {
  let tenantId: string;
  let vehicleId: string;

  beforeEach(async () => {
    await resetDb();
    tenantId = await createTenant({ slug: "deiz-test", rules: { inventoryAuthoritative: false, vatPercent: 5, maxDrivers: 2, minAge: 21 } });
    await asTenant(tenantId, async (db) => {
      const v = await createVehicle(db, tenantId, {
        make: "Mercedes-Benz", model: "G63 AMG", year: 2024, category: "suv", plate: null,
        dailyRate: toMinor(2500), weeklyRate: toMinor(15000), monthlyRate: null,
        deposit: toMinor(5000), dailyKm: 250, extraKmRate: toMinor(3), minAge: 25, minDays: 1,
      });
      vehicleId = v.id;
      await createVehicle(db, tenantId, {
        make: "Nissan", model: "Patrol", year: 2024, category: "suv", plate: null,
        dailyRate: toMinor(750), weeklyRate: null, monthlyRate: null,
        deposit: toMinor(1500), dailyKm: 250, extraKmRate: toMinor(2), minAge: 22, minDays: 1,
      });
    });
  });

  afterAll(async () => { await closePool(); });

  it("greets, then quotes once it has a car and dates", async () => {
    const r1 = await asTenant(tenantId, (db) => ingestInbound(db, tenantId, inbound("hello"), { companyName: "DEIZ" }));
    expect(r1.reply).toMatch(/DEIZ/);
    expect(r1.replyQueued).toBe(true);

    const r2 = await asTenant(tenantId, (db) =>
      ingestInbound(db, tenantId, inbound("how much for the G63 tomorrow for 3 days"), { companyName: "DEIZ" }),
    );
    expect(r2.quoteId).toBeTruthy();
    expect(r2.reply).toMatch(/G63/);
    // 3 x 2500 = 7500 + 5% VAT = 7875
    expect(r2.reply).toMatch(/7,875/);
    expect(r2.reply).toMatch(/Deposit/i);
  });

  it("discloses that availability is unconfirmed when no inventory source is connected", async () => {
    const r = await asTenant(tenantId, (db) =>
      ingestInbound(db, tenantId, inbound("G63 tomorrow for 2 days"), { companyName: "DEIZ" }),
    );
    expect(r.reply).toMatch(/subject to confirmation/i);
  });

  it("carries slots across turns", async () => {
    await asTenant(tenantId, (db) => ingestInbound(db, tenantId, inbound("do you have the G63?"), { companyName: "DEIZ" }));
    const r = await asTenant(tenantId, (db) =>
      ingestInbound(db, tenantId, inbound("tomorrow for 2 days"), { companyName: "DEIZ" }),
    );
    // The car came from the earlier message; the dates from this one.
    expect(r.reply).toMatch(/G63/);
    expect(r.quoteId).toBeTruthy();
  });

  it("answers in Arabic when the customer writes in Arabic", async () => {
    const r = await asTenant(tenantId, (db) =>
      ingestInbound(db, tenantId, inbound("كم سعر الجي 63 غدا لمدة ٣ أيام"), { companyName: "ديز" }),
    );
    expect(r.reply).toMatch(/[؀-ۿ]/);
    expect(r.reply).toMatch(/7,875|٧/);
  });

  it("never answers twice for a replayed webhook", async () => {
    const m = inbound("G63 tomorrow for 2 days", "wamid.FIXED");
    const first = await asTenant(tenantId, (db) => ingestInbound(db, tenantId, m, { companyName: "DEIZ" }));
    const second = await asTenant(tenantId, (db) => ingestInbound(db, tenantId, m, { companyName: "DEIZ" }));
    expect(first.duplicate).toBe(false);
    expect(second.duplicate).toBe(true);
    expect(second.replyQueued).toBe(false);

    const msgs = await asTenant(tenantId, (db) => listMessages(db, tenantId, first.conversationId));
    expect(msgs.filter((m) => m.direction === "inbound")).toHaveLength(1);
    expect(msgs.filter((m) => m.direction === "outbound")).toHaveLength(1);
  });

  it("escalates instead of inventing an answer when the customer asks for a person", async () => {
    const r = await asTenant(tenantId, (db) =>
      ingestInbound(db, tenantId, inbound("can I speak to a real person please"), { companyName: "DEIZ" }),
    );
    expect(r.escalated).toBe(true);
  });

  it("escalates non-text messages rather than guessing", async () => {
    const img: NormalisedInbound = { ...inbound(""), text: null };
    const r = await asTenant(tenantId, (db) => ingestInbound(db, tenantId, img, { companyName: "DEIZ" }));
    expect(r.escalated).toBe(true);
    expect(r.replyQueued).toBe(false);
  });

  it("goes silent the moment a human takes the conversation", async () => {
    const userId = await createUser({ email: "op@x.com", name: "Op", password: "pw-123456", role: "client_operator", tenantIds: [tenantId] });
    const first = await asTenant(tenantId, (db) => ingestInbound(db, tenantId, inbound("hello"), { companyName: "DEIZ" }));
    await asTenant(tenantId, (db) => takeOver(db, tenantId, first.conversationId, userId));

    const r = await asTenant(tenantId, (db) =>
      ingestInbound(db, tenantId, inbound("G63 tomorrow for 3 days"), { companyName: "DEIZ" }),
    );
    expect(r.reply).toBeNull();
    expect(r.replyQueued).toBe(false);
  });

  it("offers an alternative when the car is already booked", async () => {
    const start = daysFromNow(1);
    const end = daysFromNow(3);
    await asTenant(tenantId, async (db) => {
      await db.query(
        `INSERT INTO vehicle_blocks (tenant_id, vehicle_id, starts_at, ends_at, reason) VALUES ($1,$2,$3,$4,'booking')`,
        [tenantId, vehicleId, start.toISOString(), end.toISOString()],
      );
    });
    const r = await asTenant(tenantId, (db) =>
      ingestInbound(db, tenantId, inbound("G63 tomorrow for 2 days"), { companyName: "DEIZ" }),
    );
    expect(r.reply).toMatch(/Patrol/);
    expect(r.quoteId).toBeNull();
  });

  it("states the real document and age rules from tenant settings", async () => {
    const r = await asTenant(tenantId, (db) =>
      ingestInbound(db, tenantId, inbound("what documents do I need?"), { companyName: "DEIZ" }),
    );
    expect(r.reply).toMatch(/passport/i);
    expect(r.reply).toMatch(/21/);
  });

  it("lists what is actually free when the customer names only dates", async () => {
    const r = await asTenant(tenantId, (db) =>
      ingestInbound(db, tenantId, inbound("anything available tomorrow for 2 days?"), { companyName: "DEIZ" }),
    );
    expect(r.reply).toMatch(/G63|Patrol/);
  });
});

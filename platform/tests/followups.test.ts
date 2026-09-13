import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { resetDb, createTenant, asTenant, daysFromNow } from "./helpers.js";
import { closePool, query } from "../src/db/index.js";
import { createVehicle } from "../src/domain/vehicles.js";
import { upsertCustomer, openConversation, recordMessage, takeOver, withinServiceWindow } from "../src/domain/conversations.js";
import { createEnquiry, createQuote } from "../src/domain/quotes.js";
import { createHold, transition, confirmReservation } from "../src/domain/reservations.js";
import { scheduleFollowups, runDueFollowups, cancelFollowups, scheduleReactivations } from "../src/domain/followups.js";
import { monthlyReport, monthPeriod, liveStats } from "../src/domain/reporting.js";
import { providerFor } from "../src/jobs/scheduler.js";
import { createUser } from "../src/core/auth.js";
import { toMinor } from "../src/core/money.js";

async function fixture(tenantId: string, phone: string) {
  return asTenant(tenantId, async (db) => {
    const v = await createVehicle(db, tenantId, {
      make: "Nissan", model: "Patrol", year: 2024, category: "suv", plate: null,
      dailyRate: toMinor(750), weeklyRate: null, monthlyRate: null, deposit: toMinor(1500),
      dailyKm: 250, extraKmRate: toMinor(2), minAge: 22, minDays: 1,
    });
    const cust = await upsertCustomer(db, tenantId, { phoneE164: phone, displayName: "Sara" });
    const conv = await openConversation(db, tenantId, cust.id, "whatsapp");
    await recordMessage(db, tenantId, {
      conversationId: conv.id, direction: "inbound", channel: "whatsapp",
      body: "hi", author: "customer", providerMessageId: `in-${phone}`,
    });
    const enquiryId = await createEnquiry(db, tenantId, { conversationId: conv.id, customerId: cust.id, channel: "whatsapp" });
    const quote = await createQuote(db, tenantId, { enquiryId, vehicleId: v.id, startsAt: daysFromNow(3), endsAt: daysFromNow(6) });
    return { vehicleId: v.id, customerId: cust.id, conversationId: conv.id, enquiryId, quote };
  });
}

describe("follow-up and recovery", () => {
  let tenantId: string;

  beforeEach(async () => {
    await resetDb();
    tenantId = await createTenant();
  });

  afterAll(async () => { await closePool(); });

  it("schedules a follow-up ladder and sends only what is due", async () => {
    const f = await fixture(tenantId, "971500001001");
    await asTenant(tenantId, async (db) => {
      const ids = await scheduleFollowups(db, tenantId, {
        conversationId: f.conversationId, enquiryId: f.enquiryId, kind: "quote_followup",
        payload: { vehicle: "Nissan Patrol" },
      });
      expect(ids).toHaveLength(3); // 4h, 24h, 72h

      const nothingYet = await runDueFollowups(db, tenantId, { now: new Date() });
      expect(nothingYet.sent).toBe(0);

      const after5h = new Date(Date.now() + 5 * 3_600_000);
      const first = await runDueFollowups(db, tenantId, { now: after5h });
      expect(first.sent).toBe(1);

      const { rows } = await db.query(`SELECT body FROM outbox WHERE tenant_id=$1`, [tenantId]);
      expect(rows[0].body).toMatch(/Nissan Patrol/);
      expect(rows[0].body).toMatch(/Sara/);
    });
  });

  it("requires an approved template once the 24h window has closed", async () => {
    const f = await fixture(tenantId, "971500001002");
    await asTenant(tenantId, async (db) => {
      await scheduleFollowups(db, tenantId, { conversationId: f.conversationId, kind: "quote_followup", payload: { vehicle: "Patrol" } });
      // 30 hours later the customer's last inbound is stale
      const later = new Date(Date.now() + 30 * 3_600_000);
      expect(withinServiceWindow(new Date(), later)).toBe(false);

      const noTemplate = await runDueFollowups(db, tenantId, { now: later });
      expect(noTemplate.templateRequired).toBeGreaterThan(0);
      expect(noTemplate.sent).toBe(0);
      expect(noTemplate.skipped).toBeGreaterThan(0);

      const { rows } = await db.query(`SELECT status, last_error FROM followups WHERE tenant_id=$1 AND status='skipped'`, [tenantId]);
      expect(rows[0].last_error).toMatch(/24h window/);
    });
  });

  it("sends as a template when one is approved", async () => {
    const f = await fixture(tenantId, "971500001003");
    await asTenant(tenantId, async (db) => {
      await scheduleFollowups(db, tenantId, { conversationId: f.conversationId, kind: "quote_followup", payload: { vehicle: "Patrol" } });
      // at +30h the 4h and 24h rungs are both due; the 72h rung is not
      const later = new Date(Date.now() + 30 * 3_600_000);
      const out = await runDueFollowups(db, tenantId, { now: later, approvedTemplates: ["quote_followup"] });
      expect(out.sent).toBe(2);
      expect(out.templateRequired).toBe(2);

      const { rows } = await db.query(`SELECT template, body FROM outbox WHERE tenant_id=$1`, [tenantId]);
      expect(rows).toHaveLength(2);
      // outside the window it must go as a template, never as free-form text
      for (const r of rows) {
        expect(r.template?.name).toBe("quote_followup");
        expect(r.body).toBeNull();
      }
    });
  });

  it("never follows up on a conversation a person has taken", async () => {
    const f = await fixture(tenantId, "971500001004");
    const userId = await createUser({ email: "human@k.com", name: "H", password: "pw-123456", role: "client_operator", tenantIds: [tenantId] });
    await asTenant(tenantId, async (db) => {
      await scheduleFollowups(db, tenantId, { conversationId: f.conversationId, kind: "quote_followup" });
      await takeOver(db, tenantId, f.conversationId, userId);
      const out = await runDueFollowups(db, tenantId, { now: new Date(Date.now() + 5 * 3_600_000) });
      expect(out.sent).toBe(0);
      expect(out.skipped).toBeGreaterThan(0);
    });
  });

  it("cancels the ladder when the customer replies", async () => {
    const f = await fixture(tenantId, "971500001005");
    await asTenant(tenantId, async (db) => {
      await scheduleFollowups(db, tenantId, { conversationId: f.conversationId, kind: "quote_followup" });
      const cancelled = await cancelFollowups(db, tenantId, f.conversationId);
      expect(cancelled).toBe(3);
      const out = await runDueFollowups(db, tenantId, { now: new Date(Date.now() + 100 * 3_600_000) });
      expect(out.sent).toBe(0);
    });
  });

  it("reactivates quiet enquiries that never became a booking, exactly once", async () => {
    const f = await fixture(tenantId, "971500001006");
    await asTenant(tenantId, async (db) => {
      await db.query(`UPDATE conversations SET last_message_at = now() - interval '20 days' WHERE tenant_id=$1 AND id=$2`, [
        tenantId, f.conversationId,
      ]);
      const n = await scheduleReactivations(db, tenantId, { quietForDays: 14 });
      expect(n).toBe(1);
      // idempotent: a second sweep must not double-message the same person
      expect(await scheduleReactivations(db, tenantId, { quietForDays: 14 })).toBe(0);
    });
  });

  it("does not reactivate a customer who already booked", async () => {
    const f = await fixture(tenantId, "971500001007");
    const userId = await createUser({ email: "b@k.com", name: "B", password: "pw-123456", role: "client_operator", tenantIds: [tenantId] });
    await asTenant(tenantId, async (db) => {
      const r = await createHold(db, tenantId, {
        quoteId: f.quote.id, customerId: f.customerId, vehicleId: f.vehicleId,
        startsAt: daysFromNow(3), endsAt: daysFromNow(6), total: f.quote.breakdown.total,
      });
      await transition(db, tenantId, r.id, "payment_pending");
      await confirmReservation(db, tenantId, r.id, "staff", { userId });
      await db.query(`UPDATE conversations SET last_message_at = now() - interval '20 days' WHERE tenant_id=$1 AND id=$2`, [
        tenantId, f.conversationId,
      ]);
      expect(await scheduleReactivations(db, tenantId, { quietForDays: 14 })).toBe(0);
    });
  });
});

describe("reporting", () => {
  let tenantId: string;

  beforeEach(async () => {
    await resetDb();
    tenantId = await createTenant();
  });

  afterAll(async () => { await closePool(); });

  it("counts confirmed revenue only, never quotes or holds", async () => {
    const f = await fixture(tenantId, "971500002001");
    const userId = await createUser({ email: "r@k.com", name: "R", password: "pw-123456", role: "client_operator", tenantIds: [tenantId] });
    const now = new Date();

    const beforeConfirm = await asTenant(tenantId, (db) => monthlyReport(db, tenantId, monthPeriod(now.getUTCFullYear(), now.getUTCMonth() + 1)));
    expect(beforeConfirm.quotes).toBe(1);
    expect(beforeConfirm.reservationsConfirmed).toBe(0);
    expect(beforeConfirm.confirmedRevenue).toBe(0);

    await asTenant(tenantId, async (db) => {
      const r = await createHold(db, tenantId, {
        quoteId: f.quote.id, customerId: f.customerId, vehicleId: f.vehicleId,
        startsAt: daysFromNow(3), endsAt: daysFromNow(6), total: f.quote.breakdown.total,
      });
      // a held booking is still not revenue
      const held = await monthlyReport(db, tenantId, monthPeriod(now.getUTCFullYear(), now.getUTCMonth() + 1));
      expect(held.confirmedRevenue).toBe(0);

      await transition(db, tenantId, r.id, "payment_pending");
      await confirmReservation(db, tenantId, r.id, "staff", { userId });
    });

    const after = await asTenant(tenantId, (db) => monthlyReport(db, tenantId, monthPeriod(now.getUTCFullYear(), now.getUTCMonth() + 1)));
    expect(after.reservationsConfirmed).toBe(1);
    expect(after.confirmedRevenue).toBe(f.quote.breakdown.total);
    expect(after.conversionRatePct).toBeGreaterThan(0);
  });

  it("reports live operational counters", async () => {
    await fixture(tenantId, "971500002002");
    const s = await asTenant(tenantId, (db) => liveStats(db, tenantId));
    expect(s.ai_active).toBe(1);
    expect(s.enquiries_24h).toBe(1);
  });
});

describe("demo isolation", () => {
  beforeEach(async () => { await resetDb(); });
  afterAll(async () => { await closePool(); });

  it("hands a demo tenant a mock provider even when real credentials exist", () => {
    process.env.WHATSAPP_ACCESS_TOKEN = "real-token";
    process.env.WHATSAPP_PHONE_NUMBER_ID = "real-id";
    const demo = providerFor("whatsapp", "demo");
    const prod = providerFor("whatsapp", "production");
    expect(demo.name).toBe("mock");
    expect(prod.name).toBe("whatsapp_cloud");
    delete process.env.WHATSAPP_ACCESS_TOKEN;
    delete process.env.WHATSAPP_PHONE_NUMBER_ID;
  });

  it("keeps demo and production data in separate tenants", async () => {
    const prod = await createTenant({ slug: "prod-co", mode: "production" });
    const demo = await createTenant({ slug: "demo-co", mode: "demo" });
    await fixture(prod, "971500003001");
    await fixture(demo, "971500003002");

    const prodConvs = await asTenant(prod, async (db) => {
      const { rows } = await db.query(`SELECT count(*)::int AS n FROM conversations`);
      return rows[0].n;
    });
    expect(prodConvs).toBe(1);

    const { rows } = await query(`SELECT mode, count(*)::int AS n FROM tenants GROUP BY mode ORDER BY mode`);
    expect(rows).toEqual([{ mode: "demo", n: 1 }, { mode: "production", n: 1 }]);
  });
});

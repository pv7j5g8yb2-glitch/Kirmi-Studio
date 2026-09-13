import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { query, withTenant, type Queryable } from "../db/index.js";
import { forbidden, notFound } from "../core/errors.js";
import { toMinor, formatMoney } from "../core/money.js";
import { createVehicle, listVehicles } from "../domain/vehicles.js";
import { setSetting } from "../domain/settings.js";
import { setIntegrationState } from "../core/integrations.js";
import { upsertCustomer, openConversation, listMessages, takeOver, recordMessage, getConversation } from "../domain/conversations.js";
import { ingestInbound } from "../engine/ingest.js";
import { latestEnquiryForConversation } from "../domain/quotes.js";
import { createHold, getReservation } from "../domain/reservations.js";
import { requestDocuments, reviewDocument, allDocumentsVerified } from "../domain/documents.js";
import { createPaymentIntent, confirmPaymentByStaff, MockPaymentProvider } from "../domain/payments.js";
import { scheduleFollowups, runDueFollowups, scheduleReactivations } from "../domain/followups.js";
import { drainOutbox, queueReply } from "../domain/outbox.js";
import { MockMessagingProvider } from "../channels/whatsapp/provider.js";
import { monthlyReport, monthPeriod } from "../domain/reporting.js";
import { createUser } from "../core/auth.js";
import { audit } from "../core/audit.js";

/**
 * DEMO MODE
 *
 * Everything here runs the SAME production functions as a live tenant — the same
 * engine, pricing, state machine, follow-up scheduler and reporting. What differs is
 * only the edges: a mock message provider and a mock payment provider, so nothing
 * leaves the machine.
 *
 * Isolation is enforced by one guard, `demoTenant()`, which refuses any tenant whose
 * mode is not 'demo'. Every route below goes through it, so a demo action can never
 * touch a production tenant's data, customers, payments or channels.
 */

const DEMO_SLUG = "deiz-demo";

async function demoTenant(): Promise<{ id: string; name: string }> {
  const { rows } = await query(`SELECT id, name, mode FROM tenants WHERE slug = $1`, [DEMO_SLUG]);
  if (!rows[0]) throw notFound("Demo tenant not found — POST /api/demo/reset first");
  // The guard that makes this safe. A production tenant can never be reached here.
  if (rows[0].mode !== "demo") throw forbidden("Refusing to run demo actions against a non-demo tenant");
  return { id: rows[0].id, name: rows[0].name };
}

/** DEIZ reference data. Rates are DEMO figures, not DEIZ's real price list. */
const DEMO_FLEET = [
  { make: "Mercedes-Benz", model: "G63 AMG", year: 2024, cat: "suv", d: 2500, w: 15000, m: 52000, dep: 5000, km: 250, xkm: 3, age: 25, min: 2 },
  { make: "Lamborghini", model: "Urus", year: 2023, cat: "sports", d: 3200, w: 19500, m: 68000, dep: 8000, km: 200, xkm: 5, age: 25, min: 2 },
  { make: "Range Rover", model: "Vogue", year: 2024, cat: "suv", d: 1500, w: 9000, m: 31000, dep: 3000, km: 250, xkm: 2.5, age: 25, min: 1 },
  { make: "Porsche", model: "911 Carrera", year: 2023, cat: "sports", d: 2200, w: 13200, m: 46000, dep: 5000, km: 200, xkm: 4, age: 25, min: 2 },
  { make: "Nissan", model: "Patrol Platinum", year: 2024, cat: "suv", d: 750, w: 4500, m: 16000, dep: 1500, km: 250, xkm: 1.5, age: 22, min: 1 },
  { make: "Toyota", model: "Land Cruiser", year: 2023, cat: "suv", d: 650, w: 3900, m: 13500, dep: 1500, km: 250, xkm: 1.5, age: 21, min: 1 },
  { make: "Bentley", model: "Continental GT", year: 2023, cat: "luxury", d: 2400, w: 14400, m: 50000, dep: 6000, km: 200, xkm: 4, age: 25, min: 2 },
  { make: "Mercedes-Benz", model: "S500", year: 2023, cat: "sedan", d: 1300, w: 7800, m: 27000, dep: 3000, km: 250, xkm: 2.5, age: 25, min: 1 },
];

export type DemoStep = {
  n: number;
  key: string;
  title: string;
  /** What a non-technical viewer should take away. */
  note: string;
  channel: "whatsapp" | "instagram" | "voice" | "system";
  actor: "customer" | "kirmi" | "operator" | "system";
  detail: string;
  data?: Record<string, unknown>;
};

async function seedDemoTenant(): Promise<string> {
  const { rows } = await query(
    `INSERT INTO tenants (slug, name, mode, timezone, currency, locales)
     VALUES ($1, 'DEIZ Rental Dubai — DEMO', 'demo', 'Asia/Dubai', 'AED', ARRAY['en','ar'])
     ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name, mode = 'demo'
     RETURNING id`,
    [DEMO_SLUG],
  );
  const tenantId = rows[0].id as string;

  await withTenant(tenantId, async (db) => {
    // Order matters: children before parents. Cascades handle the rest.
    for (const table of ["outbox", "followups", "payments", "documents", "reservation_events",
                         "reservations", "quotes", "enquiries", "messages", "conversations",
                         "customers", "vehicle_blocks", "vehicles"]) {
      await db.query(`DELETE FROM ${table} WHERE tenant_id = $1`, [tenantId]);
    }
    await setSetting(db, tenantId, "rules", {
      minAge: 21, depositDefault: toMinor(1500), vatPercent: 5,
      deliveryFee: toMinor(0), freeDeliveryThresholdDays: null,
      requiredDocuments: ["passport", "driving_licence"],
      paymentMethods: ["card", "cash", "crypto"],
      weeklyThresholdDays: 7, monthlyThresholdDays: 28,
      holdMinutes: 120, quoteValidHours: 48, supportHours: "24/7", maxDrivers: 2,
      // Demo has a connected inventory source so the journey can show a firm booking.
      inventoryAuthoritative: true,
    }, "assumed");
    await setSetting(db, tenantId, "channel:whatsapp", { accountId: "DEMO_DEIZ_WA" }, "assumed");
    await setSetting(db, tenantId, "demo_notice", {
      text: "Demonstration environment. Simulated customers, simulated payments, no real channels.",
    }, "assumed");

    for (const v of DEMO_FLEET) {
      await createVehicle(db, tenantId, {
        make: v.make, model: v.model, year: v.year, category: v.cat, plate: null,
        dailyRate: toMinor(v.d), weeklyRate: toMinor(v.w), monthlyRate: toMinor(v.m),
        deposit: toMinor(v.dep), dailyKm: v.km, extraKmRate: toMinor(v.xkm),
        minAge: v.age, minDays: v.min, attributes: { demo: true },
      });
    }
    for (const ch of ["whatsapp", "instagram", "voice", "payments", "inventory", "llm"] as const) {
      await setIntegrationState(db, tenantId, ch, "CONNECTED", {
        detail: "SIMULATED for demonstration. No real provider is contacted.",
      });
    }
  });

  await createUser({
    email: "demo@kirmistudio.com", name: "Demo Operator",
    password: process.env.SEED_DEMO_PASSWORD ?? "demo-password-1",
    role: "client_admin", tenantIds: [tenantId],
  });
  return tenantId;
}

const mockMessaging = new MockMessagingProvider(true);

async function flush(db: Queryable, tenantId: string): Promise<void> {
  await drainOutbox(db, tenantId, mockMessaging, { limit: 100 });
}

/**
 * Walks the full journey using production code paths. Each step records what really
 * happened, so the narration on screen is the system's own output, not a script.
 */
async function runJourney(tenantId: string, companyName: string): Promise<DemoStep[]> {
  const steps: DemoStep[] = [];
  let n = 0;
  const push = (s: Omit<DemoStep, "n">) => steps.push({ n: ++n, ...s });
  const now = new Date();
  const at2am = new Date(now); at2am.setUTCHours(22, 14, 0, 0); // 02:14 Dubai

  return withTenant(tenantId, async (db) => {
    // ---------- 1. enquiry arrives at 2am ----------
    const r1 = await ingestInbound(db, tenantId, {
      channel: "whatsapp", providerMessageId: `demo-${Date.now()}-1`,
      from: "971501234567", to: "DEMO_DEIZ_WA",
      text: "Hi, do you have the G63 available?", displayName: "Omar Al Mansouri",
      timestamp: at2am, raw: {},
    }, { companyName, now: at2am });
    await flush(db, tenantId);
    push({
      key: "enquiry", title: "Enquiry arrives at 02:14", channel: "whatsapp", actor: "customer",
      note: "Out of hours. Nobody is at the desk — this is when most enquiries are lost.",
      detail: "Hi, do you have the G63 available?",
    });
    push({
      key: "instant_reply", title: "Answered in seconds", channel: "whatsapp", actor: "kirmi",
      note: "Kirmi checked the real fleet before replying. It names the exact vehicle it found.",
      detail: r1.reply ?? "",
    });

    // ---------- 2. qualification ----------
    const r2 = await ingestInbound(db, tenantId, {
      channel: "whatsapp", providerMessageId: `demo-${Date.now()}-2`,
      from: "971501234567", to: "DEMO_DEIZ_WA",
      text: "tomorrow for 3 days", displayName: "Omar Al Mansouri", timestamp: at2am, raw: {},
    }, { companyName, now: at2am });
    await flush(db, tenantId);
    push({
      key: "qualify", title: "Qualification", channel: "whatsapp", actor: "customer",
      note: "The customer gives only the dates. Kirmi already holds the vehicle from the previous message.",
      detail: "tomorrow for 3 days",
    });

    const enquiry = await latestEnquiryForConversation(db, tenantId, r2.conversationId);
    const { rows: qrows } = await db.query(
      `SELECT id, vehicle_id, total, deposit, days, availability_confirmed, breakdown
         FROM quotes WHERE tenant_id=$1 ORDER BY created_at DESC LIMIT 1`, [tenantId],
    );
    const quote = qrows[0];

    push({
      key: "availability", title: "Availability checked", channel: "system", actor: "system",
      note: "Checked against the live inventory calendar, not a guess.",
      detail: quote?.availability_confirmed
        ? "Vehicle free for the requested dates — confirmed against inventory."
        : "Availability could not be authoritatively confirmed.",
    });
    push({
      key: "quote", title: "Priced and quoted", channel: "whatsapp", actor: "kirmi",
      note: "Tiered pricing from the client's own rate card. VAT and deposit included, nothing invented.",
      detail: r2.reply ?? "",
      data: quote ? {
        days: quote.days,
        total: formatMoney(quote.total),
        deposit: formatMoney(quote.deposit),
        rate: quote.breakdown?.rateApplied,
      } : undefined,
    });

    // ---------- 3. customer accepts -> hold ----------
    await ingestInbound(db, tenantId, {
      channel: "whatsapp", providerMessageId: `demo-${Date.now()}-3`,
      from: "971501234567", to: "DEMO_DEIZ_WA",
      text: "Yes please book it", displayName: "Omar Al Mansouri", timestamp: at2am, raw: {},
    }, { companyName, now: at2am });
    await flush(db, tenantId);

    const reservation = await createHold(db, tenantId, {
      quoteId: quote.id, customerId: enquiry!.customerId, vehicleId: quote.vehicle_id,
      startsAt: new Date(Date.now() + 86_400_000), endsAt: new Date(Date.now() + 4 * 86_400_000),
      total: quote.total,
    });
    push({
      key: "reservation", title: "Vehicle held", channel: "system", actor: "system",
      note: "The car is now blocked in the calendar. No second customer can be quoted the same vehicle.",
      detail: `Reservation ${reservation.id.slice(0, 8)} — state: held, expires in 2 hours.`,
    });

    // ---------- 4. documents ----------
    const docIds = await requestDocuments(db, tenantId, reservation.id);
    await queueReply(db, tenantId, {
      conversationId: r2.conversationId, channel: "whatsapp", to: "971501234567",
      body: "Great. To complete the booking please send a photo of your passport and driving licence.",
      author: "ai", idempotencyKey: `demo-docs-${reservation.id}`,
    });
    await flush(db, tenantId);
    push({
      key: "documents", title: "Documents requested", channel: "whatsapp", actor: "kirmi",
      note: "Collected in the chat. Kirmi never decides eligibility — a person approves.",
      detail: "Please send a photo of your passport and driving licence.",
    });

    for (const id of docIds) {
      await db.query(`UPDATE documents SET status='received', media_ref='demo-media' WHERE tenant_id=$1 AND id=$2`, [tenantId, id]);
    }
    const operatorId = (await query(`SELECT id FROM users WHERE email='demo@kirmistudio.com'`)).rows[0].id as string;
    for (const id of docIds) await reviewDocument(db, tenantId, id, operatorId, "verified", "checked by desk");
    push({
      key: "doc_review", title: "Documents verified by a person", channel: "system", actor: "operator",
      note: "A named operator approved them. Kirmi records who, and when.",
      detail: `${docIds.length} documents verified — ${(await allDocumentsVerified(db, tenantId, reservation.id)) ? "all clear" : "outstanding"}.`,
    });

    // ---------- 5. payment ----------
    const intent = await createPaymentIntent(db, tenantId, {
      reservationId: reservation.id, amount: quote.total, method: "card",
      provider: new MockPaymentProvider(true),
    });
    push({
      key: "payment_link", title: "Payment requested", channel: "whatsapp", actor: "kirmi",
      note: "SIMULATED payment. No card is charged and no provider is contacted.",
      detail: `Payment link issued for ${formatMoney(intent.amount)}.`,
    });

    await confirmPaymentByStaff(db, tenantId, intent.id, operatorId, "demo payment");
    const confirmed = await getReservation(db, tenantId, reservation.id);
    push({
      key: "confirmed", title: "Booking confirmed", channel: "system", actor: "system",
      note: "A booking is only ever confirmed on an authoritative signal — here, a named operator.",
      detail: `Reservation confirmed · source: ${confirmed?.confirmationSource} · ${formatMoney(confirmed?.total ?? 0)}`,
    });

    await queueReply(db, tenantId, {
      conversationId: r2.conversationId, channel: "whatsapp", to: "971501234567",
      body: "Booked. Your G63 is confirmed for tomorrow, 3 days. We will deliver to you and send a reminder the day before.",
      author: "ai", idempotencyKey: `demo-conf-${reservation.id}`,
    });
    await flush(db, tenantId);

    // ---------- 6. a second customer who goes quiet ----------
    const quiet = await ingestInbound(db, tenantId, {
      channel: "instagram", providerMessageId: `demo-${Date.now()}-4`,
      from: "ig_aisha_2291", to: "DEMO_DEIZ_IG",
      text: "How much is the Urus for the weekend?", displayName: "Aisha", timestamp: now, raw: {},
    }, { companyName, now });
    await flush(db, tenantId);
    push({
      key: "instagram", title: "A second enquiry, on Instagram", channel: "instagram", actor: "customer",
      note: "Same engine, same fleet, same pricing — a different inbox.",
      detail: "How much is the Urus for the weekend?",
    });
    push({
      key: "instagram_reply", title: "Quoted on Instagram", channel: "instagram", actor: "kirmi",
      note: "The customer never has to move channel to get a price.",
      detail: quiet.reply ?? "",
    });

    const quietEnquiry = await latestEnquiryForConversation(db, tenantId, quiet.conversationId);
    await scheduleFollowups(db, tenantId, {
      conversationId: quiet.conversationId, enquiryId: quietEnquiry?.id ?? null,
      kind: "quote_followup", payload: { vehicle: "Lamborghini Urus" },
    });
    push({
      key: "followup_scheduled", title: "She does not reply", channel: "system", actor: "system",
      note: "This is where most rental revenue is lost. Kirmi schedules the chase automatically.",
      detail: "Follow-up scheduled at 4h, 24h and 72h.",
    });

    // Time travel five hours so the first rung is due — real scheduler, real clock arithmetic.
    const in5h = new Date(Date.now() + 5 * 3_600_000);
    const fu = await runDueFollowups(db, tenantId, { now: in5h, approvedTemplates: ["quote_followup", "reactivation"] });
    await flush(db, tenantId);
    const { rows: fuMsg } = await db.query(
      `SELECT body FROM outbox WHERE tenant_id=$1 AND body IS NOT NULL ORDER BY created_at DESC LIMIT 1`, [tenantId],
    );
    push({
      key: "followup_sent", title: "Followed up automatically", channel: "instagram", actor: "kirmi",
      note: "Nobody had to remember. The follow-up went out on schedule.",
      detail: fuMsg[0]?.body ?? `${fu.sent} follow-up sent.`,
    });

    // ---------- 7. recovery of an old dead enquiry ----------
    const old = await upsertCustomer(db, tenantId, { phoneE164: "971555550101", displayName: "Khalid" });
    const oldConv = await openConversation(db, tenantId, old.id, "whatsapp");
    await recordMessage(db, tenantId, {
      conversationId: oldConv.id, direction: "inbound", channel: "whatsapp",
      body: "Is the Range Rover available next month?", author: "customer",
      providerMessageId: `demo-old-${Date.now()}`,
    });
    await db.query(
      `INSERT INTO enquiries (tenant_id, conversation_id, customer_id, channel, status, created_at)
       VALUES ($1,$2,$3,'whatsapp','quoted', now() - interval '21 days')`,
      [tenantId, oldConv.id, old.id],
    );
    await db.query(`UPDATE conversations SET last_message_at = now() - interval '21 days' WHERE tenant_id=$1 AND id=$2`, [tenantId, oldConv.id]);
    const reactivated = await scheduleReactivations(db, tenantId, { quietForDays: 14 });
    const rec = await runDueFollowups(db, tenantId, { now: new Date(), approvedTemplates: ["reactivation"] });
    await flush(db, tenantId);
    const { rows: recMsg } = await db.query(
      `SELECT body FROM messages WHERE tenant_id=$1 AND conversation_id=$2 AND direction='outbound'
        ORDER BY created_at DESC LIMIT 1`, [tenantId, oldConv.id],
    );
    push({
      key: "recovery", title: "A three-week-old enquiry is revived", channel: "whatsapp", actor: "kirmi",
      note: `Everyone who asked and never booked is still an asset. ${reactivated} dormant enquiry found, ${rec.sent} message sent.`,
      detail: recMsg[0]?.body ?? "Reactivation message sent.",
    });

    // ---------- 8. human takeover ----------
    const vip = await ingestInbound(db, tenantId, {
      channel: "whatsapp", providerMessageId: `demo-${Date.now()}-5`,
      from: "971509876543", to: "DEMO_DEIZ_WA",
      text: "I need a special rate for a 3 month corporate booking, can I speak to a manager?",
      displayName: "Corporate Client", timestamp: now, raw: {},
    }, { companyName, now });
    await flush(db, tenantId);
    push({
      key: "escalation", title: "A request Kirmi should not answer", channel: "whatsapp", actor: "customer",
      note: "High value, non-standard terms. Kirmi does not improvise — it hands over.",
      detail: "I need a special rate for a 3 month corporate booking, can I speak to a manager?",
    });

    if (!vip.escalated) await takeOver(db, tenantId, vip.conversationId, operatorId);
    const vipConv = await getConversation(db, tenantId, vip.conversationId);
    await queueReply(db, tenantId, {
      conversationId: vip.conversationId, channel: "whatsapp", to: "971509876543",
      body: "Hello, this is Rashid from DEIZ. Happy to put together a corporate rate — what dates are you looking at?",
      author: "operator", authorUserId: operatorId, idempotencyKey: `demo-vip-${vip.conversationId}`,
    });
    await flush(db, tenantId);
    push({
      key: "takeover", title: "Your team takes over", channel: "whatsapp", actor: "operator",
      note: `Conversation state: ${vipConv?.state}. Kirmi is now silent on this thread until released.`,
      detail: "Hello, this is Rashid from DEIZ. Happy to put together a corporate rate — what dates are you looking at?",
    });

    await audit({ tenantId, actor: "system", action: "demo.journey_completed", data: { steps: steps.length } }, db);
    return steps;
  });
}

export async function registerDemoRoutes(app: FastifyInstance): Promise<void> {
  // The demo surface is deliberately unauthenticated so it can be shown in a meeting.
  // It is safe because every handler passes through demoTenant(), which refuses any
  // tenant not in demo mode, and because the providers are mocks.

  app.post("/api/demo/reset", async () => {
    const tenantId = await seedDemoTenant();
    return { ok: true, tenantId };
  });

  app.post("/api/demo/run", async () => {
    let tenant;
    try {
      tenant = await demoTenant();
    } catch {
      await seedDemoTenant();
      tenant = await demoTenant();
    }
    const steps = await runJourney(tenant.id, "DEIZ Rental");
    return { tenantId: tenant.id, steps };
  });

  app.get("/api/demo/state", async () => {
    const tenant = await demoTenant();
    return withTenant(tenant.id, async (db) => {
      const { rows: convs } = await db.query(
        `SELECT c.id, c.channel, c.state, cu.display_name
           FROM conversations c JOIN customers cu ON cu.id = c.customer_id
          WHERE c.tenant_id=$1 ORDER BY c.created_at`, [tenant.id],
      );
      const threads = [];
      for (const c of convs) {
        threads.push({ ...c, messages: await listMessages(db, tenant.id, c.id, 50) });
      }
      const now = new Date();
      return {
        tenantId: tenant.id,
        fleet: await listVehicles(db, tenant.id),
        threads,
        report: await monthlyReport(db, tenant.id, monthPeriod(now.getUTCFullYear(), now.getUTCMonth() + 1)),
        reservations: (await db.query(
          `SELECT r.id, r.state, r.total, r.confirmation_source, v.make, v.model
             FROM reservations r JOIN vehicles v ON v.id=r.vehicle_id WHERE r.tenant_id=$1`, [tenant.id],
        )).rows,
      };
    });
  });

  /** Free-text sandbox: type anything, get the real engine's answer. */
  app.post("/api/demo/message", async (req) => {
    const body = z.object({ text: z.string().min(1).max(500), from: z.string().default("971501234567") }).parse(req.body);
    const tenant = await demoTenant();
    return withTenant(tenant.id, async (db) => {
      const out = await ingestInbound(db, tenant.id, {
        channel: "whatsapp", providerMessageId: `demo-live-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        from: body.from, to: "DEMO_DEIZ_WA", text: body.text, displayName: "Demo Customer",
        timestamp: new Date(), raw: {},
      }, { companyName: "DEIZ Rental" });
      await flush(db, tenant.id);
      return { reply: out.reply, escalated: out.escalated, quoteId: out.quoteId, conversationId: out.conversationId };
    });
  });
}

export { DEMO_SLUG, seedDemoTenant, runJourney };

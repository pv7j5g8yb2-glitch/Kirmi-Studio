import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { resetDb, createTenant, asTenant, daysFromNow } from "./helpers.js";
import { closePool } from "../src/db/index.js";
import { createVehicle } from "../src/domain/vehicles.js";
import { upsertCustomer, openConversation } from "../src/domain/conversations.js";
import { createEnquiry, createQuote } from "../src/domain/quotes.js";
import { createHold, confirmReservation, transition, canTransition, expireStaleHolds, getReservation } from "../src/domain/reservations.js";
import { checkAvailability, placeBlock } from "../src/domain/availability.js";
import { requestDocuments, documentsFor, reviewDocument, allDocumentsVerified } from "../src/domain/documents.js";
import { createPaymentIntent, confirmPaymentByStaff, MockPaymentProvider } from "../src/domain/payments.js";
import { drainOutbox, enqueue, backoffMs } from "../src/domain/outbox.js";
import { MockMessagingProvider } from "../src/channels/whatsapp/provider.js";
import { createUser } from "../src/core/auth.js";
import { toMinor } from "../src/core/money.js";

describe("reservation state machine", () => {
  let tenantId: string; let vehicleId: string; let quoteId: string; let customerId: string; let userId: string;

  beforeEach(async () => {
    await resetDb();
    tenantId = await createTenant({ rules: { holdMinutes: 60, vatPercent: 5, requiredDocuments: ["passport", "driving_licence"] } });
    userId = await createUser({ email: "op@k.com", name: "Op", password: "pw-123456", role: "client_operator", tenantIds: [tenantId] });
    await asTenant(tenantId, async (db) => {
      const v = await createVehicle(db, tenantId, {
        make: "Nissan", model: "Patrol", year: 2024, category: "suv", plate: null,
        dailyRate: toMinor(750), weeklyRate: null, monthlyRate: null, deposit: toMinor(1500),
        dailyKm: 250, extraKmRate: toMinor(2), minAge: 22, minDays: 1,
      });
      vehicleId = v.id;
      const cust = await upsertCustomer(db, tenantId, { phoneE164: "971500000001", displayName: "Sara" });
      customerId = cust.id;
      const conv = await openConversation(db, tenantId, cust.id, "whatsapp");
      const enquiryId = await createEnquiry(db, tenantId, { conversationId: conv.id, customerId: cust.id, channel: "whatsapp" });
      const q = await createQuote(db, tenantId, { enquiryId, vehicleId: v.id, startsAt: daysFromNow(2), endsAt: daysFromNow(5) });
      quoteId = q.id;
    });
  });

  afterAll(async () => { await closePool(); });

  it("rejects illegal transitions", () => {
    expect(canTransition("draft", "confirmed")).toBe(false);
    expect(canTransition("held", "payment_pending")).toBe(true);
    expect(canTransition("cancelled", "confirmed")).toBe(false);
    expect(canTransition("confirmed", "completed")).toBe(true);
  });

  it("a hold blocks the vehicle so a second customer cannot take it", async () => {
    await asTenant(tenantId, async (db) => {
      await createHold(db, tenantId, {
        quoteId, customerId, vehicleId, startsAt: daysFromNow(2), endsAt: daysFromNow(5), total: toMinor(2362.5),
      });
      const avail = await checkAvailability(db, tenantId, vehicleId, daysFromNow(3), daysFromNow(4));
      expect(avail.available).toBe(false);
    });
  });

  it("a second hold on the same window is refused", async () => {
    await asTenant(tenantId, async (db) => {
      await createHold(db, tenantId, { quoteId, customerId, vehicleId, startsAt: daysFromNow(2), endsAt: daysFromNow(5), total: 100 });
    });
    await expect(
      asTenant(tenantId, (db) =>
        createHold(db, tenantId, { quoteId, customerId, vehicleId, startsAt: daysFromNow(3), endsAt: daysFromNow(6), total: 100 }),
      ),
    ).rejects.toThrow(/no longer free/i);
  });

  it("adjacent rentals do not collide", async () => {
    await asTenant(tenantId, async (db) => {
      await placeBlock(db, tenantId, { vehicleId, startsAt: daysFromNow(2), endsAt: daysFromNow(4), reason: "booking" });
      // starts exactly when the previous ends
      const next = await checkAvailability(db, tenantId, vehicleId, daysFromNow(4), daysFromNow(6));
      expect(next.available).toBe(true);
    });
  });

  it("cannot jump from held straight to confirmed", async () => {
    await asTenant(tenantId, async (db) => {
      const r = await createHold(db, tenantId, { quoteId, customerId, vehicleId, startsAt: daysFromNow(2), endsAt: daysFromNow(5), total: 100 });
      // documents or payment must come first; there is no shortcut to a confirmed booking
      await expect(confirmReservation(db, tenantId, r.id, "staff", { userId })).rejects.toThrow(/state held/i);
    });
  });

  it("staff confirmation must name the operator who takes responsibility", async () => {
    await asTenant(tenantId, async (db) => {
      const r = await createHold(db, tenantId, { quoteId, customerId, vehicleId, startsAt: daysFromNow(2), endsAt: daysFromNow(5), total: 100 });
      await transition(db, tenantId, r.id, "payment_pending");
      await expect(confirmReservation(db, tenantId, r.id, "staff", {})).rejects.toThrow(/operator/i);
      const still = await getReservation(db, tenantId, r.id);
      expect(still?.state).toBe("payment_pending");
    });
  });

  it("confirms on staff authority and records who did it", async () => {
    await asTenant(tenantId, async (db) => {
      const r = await createHold(db, tenantId, { quoteId, customerId, vehicleId, startsAt: daysFromNow(2), endsAt: daysFromNow(5), total: 100 });
      await transition(db, tenantId, r.id, "payment_pending");
      const done = await confirmReservation(db, tenantId, r.id, "staff", { userId, reason: "cash taken at desk" });
      expect(done.state).toBe("confirmed");
      expect(done.confirmationSource).toBe("staff");

      const { rows } = await db.query(`SELECT confirmed_by_user_id FROM reservations WHERE id=$1`, [r.id]);
      expect(rows[0].confirmed_by_user_id).toBe(userId);

      // the hold became a firm booking block
      const { rows: blocks } = await db.query(`SELECT reason FROM vehicle_blocks WHERE reference_id=$1`, [r.id]);
      expect(blocks[0].reason).toBe("booking");
    });
  });

  it("expires stale holds and frees the vehicle", async () => {
    await asTenant(tenantId, async (db) => {
      const r = await createHold(db, tenantId, { quoteId, customerId, vehicleId, startsAt: daysFromNow(2), endsAt: daysFromNow(5), total: 100 });
      const later = new Date(Date.now() + 2 * 3_600_000);
      const expired = await expireStaleHolds(db, tenantId, later);
      expect(expired).toContain(r.id);
      const after = await getReservation(db, tenantId, r.id);
      expect(after?.state).toBe("expired");
      const avail = await checkAvailability(db, tenantId, vehicleId, daysFromNow(2), daysFromNow(5));
      expect(avail.available).toBe(true);
    });
  });

  it("runs the document workflow with operator review", async () => {
    await asTenant(tenantId, async (db) => {
      const r = await createHold(db, tenantId, { quoteId, customerId, vehicleId, startsAt: daysFromNow(2), endsAt: daysFromNow(5), total: 100 });
      const ids = await requestDocuments(db, tenantId, r.id);
      expect(ids).toHaveLength(2);
      expect((await getReservation(db, tenantId, r.id))?.state).toBe("documents_pending");
      expect(await allDocumentsVerified(db, tenantId, r.id)).toBe(false);

      for (const id of ids) await reviewDocument(db, tenantId, id, userId, "verified");
      expect(await allDocumentsVerified(db, tenantId, r.id)).toBe(true);
      const docs = await documentsFor(db, tenantId, r.id);
      expect(docs.every((d) => d.status === "verified")).toBe(true);
    });
  });
});

describe("payments", () => {
  let tenantId: string; let userId: string; let reservationId: string;

  beforeEach(async () => {
    await resetDb();
    tenantId = await createTenant();
    userId = await createUser({ email: "cash@k.com", name: "Desk", password: "pw-123456", role: "client_operator", tenantIds: [tenantId] });
    await asTenant(tenantId, async (db) => {
      const v = await createVehicle(db, tenantId, {
        make: "Toyota", model: "Land Cruiser", year: 2023, category: "suv", plate: null,
        dailyRate: toMinor(650), weeklyRate: null, monthlyRate: null, deposit: toMinor(1500),
        dailyKm: 250, extraKmRate: toMinor(1.5), minAge: 21, minDays: 1,
      });
      const cust = await upsertCustomer(db, tenantId, { phoneE164: "971500000002" });
      const conv = await openConversation(db, tenantId, cust.id, "whatsapp");
      const enquiryId = await createEnquiry(db, tenantId, { conversationId: conv.id, customerId: cust.id, channel: "whatsapp" });
      const q = await createQuote(db, tenantId, { enquiryId, vehicleId: v.id, startsAt: daysFromNow(1), endsAt: daysFromNow(3) });
      const r = await createHold(db, tenantId, {
        quoteId: q.id, customerId: cust.id, vehicleId: v.id,
        startsAt: daysFromNow(1), endsAt: daysFromNow(3), total: q.breakdown.total,
      });
      reservationId = r.id;
    });
  });

  afterAll(async () => { await closePool(); });

  it("cash can only be confirmed by a named operator, never by a provider", async () => {
    await asTenant(tenantId, async (db) => {
      const intent = await createPaymentIntent(db, tenantId, {
        reservationId, amount: toMinor(1365), method: "cash", provider: new MockPaymentProvider(true),
      });
      // cash never gets a checkout url even when a provider is configured
      expect(intent.checkoutUrl).toBeNull();
      expect(intent.status).toBe("pending");

      await confirmPaymentByStaff(db, tenantId, intent.id, userId, "counted at desk");
      const r = await getReservation(db, tenantId, reservationId);
      expect(r?.state).toBe("confirmed");
      expect(r?.confirmationSource).toBe("staff");
    });
  });

  it("card payments get a checkout link when a provider is configured", async () => {
    await asTenant(tenantId, async (db) => {
      const intent = await createPaymentIntent(db, tenantId, {
        reservationId, amount: toMinor(1365), method: "card", provider: new MockPaymentProvider(true),
      });
      expect(intent.checkoutUrl).toContain("/pay/");
      expect(intent.providerRef).toBeTruthy();
    });
  });

  it("an unconfigured provider yields no link and leaves the booking unconfirmed", async () => {
    await asTenant(tenantId, async (db) => {
      const intent = await createPaymentIntent(db, tenantId, {
        reservationId, amount: toMinor(1365), method: "card", provider: new MockPaymentProvider(false),
      });
      expect(intent.checkoutUrl).toBeNull();
      const r = await getReservation(db, tenantId, reservationId);
      expect(r?.state).toBe("payment_pending");
      expect(r?.confirmedAt).toBeNull();
    });
  });
});

describe("outbox delivery", () => {
  let tenantId: string;

  beforeEach(async () => {
    await resetDb();
    tenantId = await createTenant();
  });

  afterAll(async () => { await closePool(); });

  it("backs off exponentially and caps", () => {
    expect(backoffMs(1)).toBe(30_000);
    expect(backoffMs(2)).toBe(60_000);
    expect(backoffMs(10)).toBe(900_000);
  });

  it("enqueue is idempotent on the idempotency key", async () => {
    await asTenant(tenantId, async (db) => {
      const a = await enqueue(db, tenantId, { channel: "whatsapp", to: "971500000003", body: "hi", idempotencyKey: "k1" });
      const b = await enqueue(db, tenantId, { channel: "whatsapp", to: "971500000003", body: "hi", idempotencyKey: "k1" });
      expect(a.created).toBe(true);
      expect(b.created).toBe(false);
      expect(b.id).toBe(a.id);
    });
  });

  it("retries a transient failure then succeeds", async () => {
    const provider = new MockMessagingProvider(true);
    provider.failNext(1);
    await asTenant(tenantId, async (db) => {
      await enqueue(db, tenantId, { channel: "whatsapp", to: "971500000004", body: "hello", idempotencyKey: "k2" });
      const first = await drainOutbox(db, tenantId, provider);
      expect(first.failed).toBe(1);
      expect(first.sent).toBe(0);

      // nothing is sent before the backoff elapses
      const tooSoon = await drainOutbox(db, tenantId, provider);
      expect(tooSoon.sent).toBe(0);

      const later = new Date(Date.now() + 60_000);
      const second = await drainOutbox(db, tenantId, provider, { now: later });
      expect(second.sent).toBe(1);
      expect(provider.sent).toHaveLength(1);
    });
  });

  it("parks messages instead of failing them when the channel is NOT_CONNECTED", async () => {
    const unconfigured = new MockMessagingProvider(false);
    await asTenant(tenantId, async (db) => {
      await enqueue(db, tenantId, { channel: "whatsapp", to: "971500000005", body: "hello", idempotencyKey: "k3" });
      const out = await drainOutbox(db, tenantId, unconfigured);
      expect(out.skipped).toBe(1);
      expect(out.dead).toBe(0);
      const { rows } = await db.query(`SELECT status, attempt FROM outbox WHERE tenant_id=$1`, [tenantId]);
      // still pending, still zero attempts: it will go out once credentials arrive
      expect(rows[0].status).toBe("pending");
      expect(rows[0].attempt).toBe(0);
    });
  });
});

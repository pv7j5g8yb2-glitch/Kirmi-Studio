import { createHmac, timingSafeEqual } from "node:crypto";
import { request } from "undici";
import type { Queryable } from "../db/index.js";
import { query, withTenant } from "../db/index.js";
import { env } from "../config/env.js";
import { audit } from "../core/audit.js";
import { badRequest } from "../core/errors.js";
import { confirmReservation, getReservation, transition } from "./reservations.js";

export type PaymentMethod = "card" | "cash" | "crypto" | "bank_transfer";
export type PaymentStatus = "pending" | "authorized" | "paid" | "confirmed_by_staff" | "failed" | "refunded";

/**
 * Only a provider webhook may move a payment to `paid`. Cash and crypto cannot
 * produce one, so they terminate at `confirmed_by_staff` and always name the operator
 * who vouched for them — a distinction the dashboard surfaces rather than hides.
 */
export const PROVIDER_BACKED: PaymentMethod[] = ["card", "bank_transfer"];

export type PaymentIntent = {
  id: string;
  reservationId: string;
  amount: number;
  currency: string;
  method: PaymentMethod;
  status: PaymentStatus;
  providerRef: string | null;
  /** Null whenever payments are NOT_CONNECTED; the operator then takes payment offline. */
  checkoutUrl: string | null;
};

export interface PaymentProvider {
  readonly name: string;
  isConfigured(): boolean;
  createCheckout(input: { amount: number; currency: string; reference: string; description: string }): Promise<
    { ok: true; providerRef: string; checkoutUrl: string } | { ok: false; error: string }
  >;
}

export class StripeProvider implements PaymentProvider {
  readonly name = "stripe";
  constructor(private readonly key = env().STRIPE_SECRET_KEY, private readonly base = "https://api.stripe.com") {}
  isConfigured(): boolean { return Boolean(this.key); }

  async createCheckout(input: { amount: number; currency: string; reference: string; description: string }) {
    if (!this.isConfigured()) return { ok: false as const, error: "Payments are NOT_CONNECTED: no Stripe key" };
    const form = new URLSearchParams({
      mode: "payment",
      "line_items[0][quantity]": "1",
      "line_items[0][price_data][currency]": input.currency.toLowerCase(),
      "line_items[0][price_data][unit_amount]": String(input.amount),
      "line_items[0][price_data][product_data][name]": input.description,
      client_reference_id: input.reference,
      success_url: `${env().PUBLIC_BASE_URL}/pay/done?ref=${encodeURIComponent(input.reference)}`,
      cancel_url: `${env().PUBLIC_BASE_URL}/pay/cancelled?ref=${encodeURIComponent(input.reference)}`,
    });
    try {
      const res = await request(`${this.base}/v1/checkout/sessions`, {
        method: "POST",
        headers: { authorization: `Bearer ${this.key}`, "content-type": "application/x-www-form-urlencoded" },
        body: form.toString(),
        headersTimeout: 15_000,
        bodyTimeout: 15_000,
      });
      const text = await res.body.text();
      if (res.statusCode >= 200 && res.statusCode < 300) {
        const j = JSON.parse(text) as { id: string; url: string };
        return { ok: true as const, providerRef: j.id, checkoutUrl: j.url };
      }
      return { ok: false as const, error: `Stripe ${res.statusCode}: ${text.slice(0, 300)}` };
    } catch (e) {
      return { ok: false as const, error: (e as Error).message };
    }
  }
}

/** Deterministic stand-in for DEMO tenants and tests. Never contacts a real provider. */
export class MockPaymentProvider implements PaymentProvider {
  readonly name = "mock";
  constructor(private readonly configured = true) {}
  isConfigured(): boolean { return this.configured; }
  async createCheckout(input: { reference: string }) {
    return { ok: true as const, providerRef: `mock_${input.reference}`, checkoutUrl: `https://demo.invalid/pay/${input.reference}` };
  }
}

export async function createPaymentIntent(
  db: Queryable,
  tenantId: string,
  input: { reservationId: string; amount: number; currency?: string; method: PaymentMethod; provider?: PaymentProvider },
): Promise<PaymentIntent> {
  const reservation = await getReservation(db, tenantId, input.reservationId);
  if (!reservation) throw badRequest("Reservation not found");
  if (input.amount <= 0) throw badRequest("Payment amount must be positive");

  const currency = input.currency ?? "AED";
  let providerRef: string | null = null;
  let checkoutUrl: string | null = null;
  let providerName: string | null = null;

  if (PROVIDER_BACKED.includes(input.method) && input.provider?.isConfigured()) {
    const out = await input.provider.createCheckout({
      amount: input.amount,
      currency,
      reference: input.reservationId,
      description: `Rental ${reservation.startsAt.slice(0, 10)} to ${reservation.endsAt.slice(0, 10)}`,
    });
    if (out.ok) {
      providerRef = out.providerRef;
      checkoutUrl = out.checkoutUrl;
      providerName = input.provider.name;
    }
  }

  const { rows } = await db.query(
    `INSERT INTO payments (tenant_id, reservation_id, amount, currency, method, provider, provider_ref, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'pending') RETURNING id`,
    [tenantId, input.reservationId, input.amount, currency, input.method, providerName, providerRef],
  );

  if (reservation.state === "held" || reservation.state === "documents_pending") {
    await transition(db, tenantId, input.reservationId, "payment_pending", { reason: "payment requested" });
  }
  await audit({ tenantId, actor: "system", action: "payment.created", entity: "payment", entityId: rows[0].id, data: { method: input.method, amount: input.amount } }, db);

  return {
    id: rows[0].id, reservationId: input.reservationId, amount: input.amount, currency,
    method: input.method, status: "pending", providerRef, checkoutUrl,
  };
}

/**
 * Staff confirmation for money that arrives outside a provider — the only route for
 * cash and crypto, and the operator is recorded against it.
 */
export async function confirmPaymentByStaff(
  db: Queryable,
  tenantId: string,
  paymentId: string,
  userId: string,
  note?: string,
): Promise<void> {
  const { rows } = await db.query(
    `SELECT id, reservation_id, method, status FROM payments WHERE tenant_id=$1 AND id=$2`,
    [tenantId, paymentId],
  );
  const p = rows[0];
  if (!p) throw badRequest("Payment not found");
  if (p.status === "paid" || p.status === "confirmed_by_staff") return;

  await db.query(
    `UPDATE payments SET status='confirmed_by_staff', confirmed_by_user_id=$3, updated_at=now()
      WHERE tenant_id=$1 AND id=$2`,
    [tenantId, paymentId, userId],
  );
  await audit({ tenantId, actor: "operator", actorUserId: userId, action: "payment.confirmed_by_staff", entity: "payment", entityId: paymentId, data: { method: p.method, note } }, db);
  await confirmReservation(db, tenantId, p.reservation_id, "staff", { userId, reason: `${p.method} confirmed by operator` });
}

/** Verifies Stripe's signed webhook, then confirms the reservation it refers to. */
export async function handleStripeWebhook(
  raw: Buffer,
  signatureHeader: string,
  secret: string,
): Promise<{ ok: boolean; handled?: string; error?: string }> {
  const parts = Object.fromEntries(
    signatureHeader.split(",").map((kv) => kv.split("=", 2) as [string, string]),
  );
  const timestamp = parts["t"];
  const provided = parts["v1"];
  if (!timestamp || !provided) return { ok: false, error: "malformed_signature" };

  // Reject old signatures so a captured webhook cannot be replayed later.
  const ageSeconds = Math.abs(Date.now() / 1000 - Number(timestamp));
  if (!Number.isFinite(ageSeconds) || ageSeconds > 300) return { ok: false, error: "stale_signature" };

  const digest = createHmac("sha256", secret).update(`${timestamp}.${raw.toString("utf8")}`).digest("hex");
  const a = Buffer.from(digest);
  const b = Buffer.from(provided);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false, error: "bad_signature" };

  const event = JSON.parse(raw.toString("utf8")) as {
    id: string;
    type: string;
    data?: { object?: { id?: string; client_reference_id?: string; amount_total?: number } };
  };

  const { rows: fresh } = await query(
    `INSERT INTO webhook_events (channel, provider_event_id, payload)
     VALUES ('payments',$1,$2) ON CONFLICT (channel, provider_event_id) DO NOTHING RETURNING id`,
    [event.id, raw.toString("utf8")],
  );
  if (!fresh.length) return { ok: true, handled: "duplicate" };

  if (event.type !== "checkout.session.completed") return { ok: true, handled: "ignored" };

  const reservationId = event.data?.object?.client_reference_id;
  const sessionId = event.data?.object?.id;
  if (!reservationId) return { ok: true, handled: "no_reference" };

  const { rows: own } = await query(`SELECT tenant_id FROM reservations WHERE id = $1`, [reservationId]);
  if (!own[0]) return { ok: true, handled: "unknown_reservation" };
  const tenantId = own[0].tenant_id as string;

  await withTenant(tenantId, async (db) => {
    await db.query(
      `UPDATE payments SET status='paid', updated_at=now()
        WHERE tenant_id=$1 AND reservation_id=$2 AND (provider_ref=$3 OR provider_ref IS NULL)`,
      [tenantId, reservationId, sessionId ?? null],
    );
    const r = await getReservation(db, tenantId, reservationId);
    if (r && r.state !== "confirmed") {
      await confirmReservation(db, tenantId, reservationId, "payment_provider", { reason: "stripe checkout completed" });
    }
  });
  return { ok: true, handled: "confirmed" };
}

export async function listPayments(db: Queryable, tenantId: string, reservationId?: string) {
  const vals: unknown[] = [tenantId];
  let where = "tenant_id = $1";
  if (reservationId) { vals.push(reservationId); where += ` AND reservation_id = $${vals.length}`; }
  const { rows } = await db.query(
    `SELECT id, reservation_id, amount, currency, method, provider, provider_ref, status, created_at
       FROM payments WHERE ${where} ORDER BY created_at DESC LIMIT 200`,
    vals,
  );
  return rows.map((r: any) => ({
    id: r.id, reservationId: r.reservation_id, amount: r.amount, currency: r.currency,
    method: r.method, provider: r.provider, providerRef: r.provider_ref, status: r.status,
    createdAt: new Date(r.created_at).toISOString(),
  }));
}

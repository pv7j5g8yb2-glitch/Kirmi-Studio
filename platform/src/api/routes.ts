import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { z } from "zod";
import { query, withTenant, withAdmin } from "../db/index.js";
import {
  authenticate, createSession, destroySession, principalFromToken,
  requirePrincipal, assertTenantAccess, assertRole, type Principal,
} from "../core/auth.js";
import { AppError, badRequest, notFound } from "../core/errors.js";
import { listIntegrations, setIntegrationState, type Channel } from "../core/integrations.js";
import { listSettings, setSetting, getRules } from "../domain/settings.js";
import { listVehicles, createVehicle, updateVehicle } from "../domain/vehicles.js";
import { listConversations, listMessages, takeOver, releaseToAi, getConversation } from "../domain/conversations.js";
import { queueReply } from "../domain/outbox.js";
import { listReservations, getReservation, createHold, transition, confirmReservation } from "../domain/reservations.js";
import { getQuote } from "../domain/quotes.js";
import { requestDocuments, documentsFor, reviewDocument } from "../domain/documents.js";
import { createPaymentIntent, confirmPaymentByStaff, listPayments, MockPaymentProvider, StripeProvider } from "../domain/payments.js";
import { monthlyReport, monthPeriod, liveStats } from "../domain/reporting.js";
import { scheduleReactivations } from "../domain/followups.js";
import { env } from "../config/env.js";

const COOKIE = "kirmi_session";

async function principalOf(req: FastifyRequest): Promise<Principal> {
  const fromCookie = (req.cookies as Record<string, string> | undefined)?.[COOKIE];
  const auth = req.headers.authorization;
  const bearer = auth?.startsWith("Bearer ") ? auth.slice(7) : undefined;
  return requirePrincipal(await principalFromToken(fromCookie ?? bearer));
}

/** Resolves :tenantId and proves the caller may act on it before any query runs. */
async function tenantOf(req: FastifyRequest): Promise<{ p: Principal; tenantId: string }> {
  const p = await principalOf(req);
  const { tenantId } = req.params as { tenantId: string };
  if (!tenantId) throw badRequest("tenantId required");
  assertTenantAccess(p, tenantId);
  return { p, tenantId };
}

export async function registerRoutes(app: FastifyInstance): Promise<void> {
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) {
      return reply.code(err.status).send({ error: err.code, message: err.message, detail: err.detail });
    }
    if (err instanceof z.ZodError) {
      return reply.code(400).send({ error: "validation_failed", issues: err.issues });
    }
    app.log.error({ err }, "unhandled route error");
    return reply.code(500).send({ error: "internal_error" });
  });

  // ----------------------------------------------------------------- auth ----
  app.post("/api/auth/login", async (req, reply) => {
    const body = z.object({ email: z.string().email(), password: z.string().min(1) }).parse(req.body);
    const principal = await authenticate(body.email, body.password);
    const { token, expiresAt } = await createSession(principal.userId);
    reply.setCookie(COOKIE, token, {
      httpOnly: true, sameSite: "lax", path: "/",
      secure: env().NODE_ENV === "production",
      expires: expiresAt,
    });
    return { user: principal };
  });

  app.post("/api/auth/logout", async (req: FastifyRequest, reply: FastifyReply) => {
    const t = (req.cookies as Record<string, string> | undefined)?.[COOKIE];
    if (t) await destroySession(t);
    reply.clearCookie(COOKIE, { path: "/" });
    return { ok: true };
  });

  app.get("/api/me", async (req) => {
    const p = await principalOf(req);
    const { rows } = await query(
      p.role === "kirmi_admin"
        ? `SELECT id, slug, name, mode FROM tenants ORDER BY name`
        : `SELECT t.id, t.slug, t.name, t.mode FROM tenants t
             JOIN memberships m ON m.tenant_id = t.id WHERE m.user_id = $1 ORDER BY t.name`,
      p.role === "kirmi_admin" ? [] : [p.userId],
    );
    return { user: p, tenants: rows };
  });

  // ------------------------------------------------------------ overview -----
  app.get("/api/tenants/:tenantId/overview", async (req) => {
    const { tenantId } = await tenantOf(req);
    return withTenant(tenantId, async (db) => ({
      stats: await liveStats(db, tenantId),
      integrations: await listIntegrations(db, tenantId),
    }));
  });

  app.get("/api/tenants/:tenantId/integrations", async (req) => {
    const { tenantId } = await tenantOf(req);
    return withTenant(tenantId, (db) => listIntegrations(db, tenantId));
  });

  app.put("/api/tenants/:tenantId/integrations/:channel", async (req) => {
    const { p, tenantId } = await tenantOf(req);
    assertRole(p, "kirmi_admin", "client_admin");
    const { channel } = req.params as { channel: Channel };
    const body = z.object({
      state: z.enum(["NOT_CONNECTED", "CONFIGURING", "CONNECTED", "ERROR", "DISCONNECTED"]),
      detail: z.string().optional(),
      requirements: z.array(z.string()).optional(),
    }).parse(req.body);
    await withTenant(tenantId, (db) => setIntegrationState(db, tenantId, channel, body.state, body));
    return { ok: true };
  });

  // ------------------------------------------------------------ settings -----
  app.get("/api/tenants/:tenantId/settings", async (req) => {
    const { tenantId } = await tenantOf(req);
    return withTenant(tenantId, (db) => listSettings(db, tenantId));
  });

  app.put("/api/tenants/:tenantId/settings/:key", async (req) => {
    const { p, tenantId } = await tenantOf(req);
    assertRole(p, "kirmi_admin", "client_admin");
    const { key } = req.params as { key: string };
    const body = z.object({
      value: z.unknown(),
      provenance: z.enum(["verified_public", "client_provided", "assumed"]).default("client_provided"),
    }).parse(req.body);
    await withTenant(tenantId, (db) => setSetting(db, tenantId, key, body.value, body.provenance));
    return { ok: true };
  });

  // ------------------------------------------------------------- fleet -------
  app.get("/api/tenants/:tenantId/vehicles", async (req) => {
    const { tenantId } = await tenantOf(req);
    const q = req.query as { all?: string };
    return withTenant(tenantId, (db) => listVehicles(db, tenantId, { includeInactive: q.all === "1" }));
  });

  const VehicleBody = z.object({
    make: z.string().min(1), model: z.string().min(1), year: z.number().int().nullable().default(null),
    category: z.string().default("standard"), plate: z.string().nullable().default(null),
    dailyRate: z.number().int().nonnegative(),
    weeklyRate: z.number().int().nonnegative().nullable().default(null),
    monthlyRate: z.number().int().nonnegative().nullable().default(null),
    deposit: z.number().int().nonnegative().default(0),
    dailyKm: z.number().int().nullable().default(null),
    extraKmRate: z.number().int().nullable().default(null),
    minAge: z.number().int().nullable().default(null),
    minDays: z.number().int().min(1).default(1),
  });

  app.post("/api/tenants/:tenantId/vehicles", async (req) => {
    const { p, tenantId } = await tenantOf(req);
    assertRole(p, "kirmi_admin", "client_admin");
    const body = VehicleBody.parse(req.body);
    return withTenant(tenantId, (db) => createVehicle(db, tenantId, body));
  });

  app.patch("/api/tenants/:tenantId/vehicles/:id", async (req) => {
    const { p, tenantId } = await tenantOf(req);
    assertRole(p, "kirmi_admin", "client_admin");
    const { id } = req.params as { id: string };
    const body = VehicleBody.partial().parse(req.body);
    const out = await withTenant(tenantId, (db) => updateVehicle(db, tenantId, id, body));
    if (!out) throw notFound("Vehicle not found");
    return out;
  });

  // ------------------------------------------------------------- inbox -------
  app.get("/api/tenants/:tenantId/conversations", async (req) => {
    const { tenantId } = await tenantOf(req);
    const q = req.query as { state?: "ai_active" | "human_active" | "closed" };
    return withTenant(tenantId, (db) => listConversations(db, tenantId, { state: q.state }));
  });

  app.get("/api/tenants/:tenantId/conversations/:id", async (req) => {
    const { tenantId } = await tenantOf(req);
    const { id } = req.params as { id: string };
    return withTenant(tenantId, async (db) => {
      const conversation = await getConversation(db, tenantId, id);
      if (!conversation) throw notFound("Conversation not found");
      return { conversation, messages: await listMessages(db, tenantId, id, 200) };
    });
  });

  app.post("/api/tenants/:tenantId/conversations/:id/takeover", async (req) => {
    const { p, tenantId } = await tenantOf(req);
    const { id } = req.params as { id: string };
    await withTenant(tenantId, (db) => takeOver(db, tenantId, id, p.userId));
    return { ok: true };
  });

  app.post("/api/tenants/:tenantId/conversations/:id/release", async (req) => {
    const { p, tenantId } = await tenantOf(req);
    const { id } = req.params as { id: string };
    await withTenant(tenantId, (db) => releaseToAi(db, tenantId, id, p.userId));
    return { ok: true };
  });

  app.post("/api/tenants/:tenantId/conversations/:id/reply", async (req) => {
    const { p, tenantId } = await tenantOf(req);
    const { id } = req.params as { id: string };
    const body = z.object({ text: z.string().min(1).max(4000) }).parse(req.body);
    return withTenant(tenantId, async (db) => {
      const conv = await getConversation(db, tenantId, id);
      if (!conv) throw notFound("Conversation not found");
      const { rows } = await db.query(
        `SELECT phone_e164, instagram_id FROM customers WHERE tenant_id=$1 AND id=$2`,
        [tenantId, conv.customerId],
      );
      const to = conv.channel === "instagram" ? rows[0]?.instagram_id : rows[0]?.phone_e164;
      if (!to) throw badRequest("Customer has no address on this channel");
      const out = await queueReply(db, tenantId, {
        conversationId: id, channel: conv.channel as "whatsapp" | "instagram" | "web",
        to, body: body.text, author: "operator", authorUserId: p.userId,
      });
      return { ok: true, ...out };
    });
  });

  // -------------------------------------------------------- reservations -----
  app.get("/api/tenants/:tenantId/reservations", async (req) => {
    const { tenantId } = await tenantOf(req);
    const q = req.query as { state?: any };
    return withTenant(tenantId, (db) => listReservations(db, tenantId, { state: q.state }));
  });

  app.post("/api/tenants/:tenantId/reservations", async (req) => {
    const { tenantId } = await tenantOf(req);
    const body = z.object({ quoteId: z.string().uuid() }).parse(req.body);
    return withTenant(tenantId, async (db) => {
      const quote = await getQuote(db, tenantId, body.quoteId);
      if (!quote) throw notFound("Quote not found");
      const { rows } = await db.query(`SELECT customer_id FROM enquiries WHERE tenant_id=$1 AND id=$2`, [
        tenantId, quote.enquiryId,
      ]);
      if (!rows[0]) throw notFound("Enquiry not found");
      return createHold(db, tenantId, {
        quoteId: quote.id, customerId: rows[0].customer_id, vehicleId: quote.vehicleId,
        startsAt: new Date(quote.startsAt), endsAt: new Date(quote.endsAt),
        total: quote.breakdown.total,
      });
    });
  });

  app.get("/api/tenants/:tenantId/reservations/:id", async (req) => {
    const { tenantId } = await tenantOf(req);
    const { id } = req.params as { id: string };
    return withTenant(tenantId, async (db) => {
      const reservation = await getReservation(db, tenantId, id);
      if (!reservation) throw notFound("Reservation not found");
      return {
        reservation,
        documents: await documentsFor(db, tenantId, id),
        payments: await listPayments(db, tenantId, id),
      };
    });
  });

  app.post("/api/tenants/:tenantId/reservations/:id/documents", async (req) => {
    const { tenantId } = await tenantOf(req);
    const { id } = req.params as { id: string };
    return withTenant(tenantId, async (db) => ({ ids: await requestDocuments(db, tenantId, id) }));
  });

  app.post("/api/tenants/:tenantId/documents/:docId/review", async (req) => {
    const { p, tenantId } = await tenantOf(req);
    const { docId } = req.params as { docId: string };
    const body = z.object({ decision: z.enum(["verified", "rejected"]), note: z.string().optional() }).parse(req.body);
    await withTenant(tenantId, (db) => reviewDocument(db, tenantId, docId, p.userId, body.decision, body.note));
    return { ok: true };
  });

  app.post("/api/tenants/:tenantId/reservations/:id/payment", async (req) => {
    const { tenantId } = await tenantOf(req);
    const { id } = req.params as { id: string };
    const body = z.object({
      amount: z.number().int().positive(),
      method: z.enum(["card", "cash", "crypto", "bank_transfer"]),
    }).parse(req.body);
    const provider = env().PAYMENT_PROVIDER === "stripe" ? new StripeProvider() : new MockPaymentProvider(false);
    return withTenant(tenantId, (db) =>
      createPaymentIntent(db, tenantId, { reservationId: id, amount: body.amount, method: body.method, provider }),
    );
  });

  app.post("/api/tenants/:tenantId/payments/:paymentId/confirm", async (req) => {
    const { p, tenantId } = await tenantOf(req);
    assertRole(p, "kirmi_admin", "client_admin", "client_operator");
    const { paymentId } = req.params as { paymentId: string };
    const body = z.object({ note: z.string().optional() }).parse(req.body ?? {});
    await withTenant(tenantId, (db) => confirmPaymentByStaff(db, tenantId, paymentId, p.userId, body.note));
    return { ok: true };
  });

  app.post("/api/tenants/:tenantId/reservations/:id/cancel", async (req) => {
    const { p, tenantId } = await tenantOf(req);
    const { id } = req.params as { id: string };
    const body = z.object({ reason: z.string().optional() }).parse(req.body ?? {});
    await withTenant(tenantId, (db) =>
      transition(db, tenantId, id, "cancelled", { reason: body.reason ?? "cancelled by operator", actor: "operator" }),
    );
    void p;
    return { ok: true };
  });

  app.post("/api/tenants/:tenantId/reservations/:id/confirm", async (req) => {
    const { p, tenantId } = await tenantOf(req);
    assertRole(p, "kirmi_admin", "client_admin", "client_operator");
    const { id } = req.params as { id: string };
    const body = z.object({ reason: z.string().optional() }).parse(req.body ?? {});
    const out = await withTenant(tenantId, (db) =>
      confirmReservation(db, tenantId, id, "staff", { userId: p.userId, reason: body.reason }),
    );
    return out;
  });

  // ---------------------------------------------------------- reporting -----
  app.get("/api/tenants/:tenantId/report", async (req) => {
    const { tenantId } = await tenantOf(req);
    const q = req.query as { year?: string; month?: string };
    const now = new Date();
    const year = q.year ? Number(q.year) : now.getUTCFullYear();
    const month = q.month ? Number(q.month) : now.getUTCMonth() + 1;
    return withTenant(tenantId, (db) => monthlyReport(db, tenantId, monthPeriod(year, month)));
  });

  app.get("/api/tenants/:tenantId/audit", async (req) => {
    const { tenantId } = await tenantOf(req);
    const { rows } = await query(
      `SELECT created_at, actor, action, entity, entity_id, data
         FROM audit_log WHERE tenant_id=$1 ORDER BY created_at DESC LIMIT 200`,
      [tenantId],
    );
    return rows.map((r: any) => ({
      at: new Date(r.created_at).toISOString(), actor: r.actor, action: r.action,
      entity: r.entity, entityId: r.entity_id, data: r.data,
    }));
  });

  app.post("/api/tenants/:tenantId/reactivations/run", async (req) => {
    const { p, tenantId } = await tenantOf(req);
    assertRole(p, "kirmi_admin", "client_admin");
    const scheduled = await withTenant(tenantId, (db) => scheduleReactivations(db, tenantId));
    return { scheduled };
  });

  app.get("/api/tenants/:tenantId/rules", async (req) => {
    const { tenantId } = await tenantOf(req);
    return withTenant(tenantId, (db) => getRules(db, tenantId));
  });

  // ------------------------------------------------------ kirmi admin -------
  app.get("/api/admin/tenants", async (req) => {
    const p = await principalOf(req);
    assertRole(p, "kirmi_admin");
    return withAdmin(async (db) => {
      const { rows } = await db.query(
        `SELECT t.id, t.slug, t.name, t.mode, t.status,
                (SELECT count(*)::int FROM conversations c WHERE c.tenant_id=t.id) AS conversations,
                (SELECT count(*)::int FROM reservations r WHERE r.tenant_id=t.id AND r.state IN ('confirmed','completed')) AS bookings,
                (SELECT count(*)::int FROM integrations i WHERE i.tenant_id=t.id AND i.state='CONNECTED') AS connected
           FROM tenants t ORDER BY t.created_at`,
      );
      return rows;
    });
  });
}

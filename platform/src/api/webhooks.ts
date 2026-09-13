import type { FastifyInstance, FastifyRequest } from "fastify";
import { createHmac, timingSafeEqual } from "node:crypto";
import { env } from "../config/env.js";
import { query, withTenant } from "../db/index.js";
import { verifySignature, verifyChallenge, parseWebhook, WhatsAppCloudProvider } from "../channels/whatsapp/provider.js";
import { parseInstagramWebhook, InstagramProvider } from "../channels/instagram/provider.js";
import { ingestInbound } from "../engine/ingest.js";
import { setIntegrationState } from "../core/integrations.js";
import { audit } from "../core/audit.js";

type RawRequest = FastifyRequest & { rawBody?: Buffer };

/**
 * Resolve which tenant a message arrived for. Routing is by the account the message
 * was delivered to (phone_number_id / IG account id), which is what makes this
 * multi-tenant rather than DEIZ-only.
 */
async function tenantForAccount(channel: string, accountId: string): Promise<{ id: string; name: string } | null> {
  const { rows } = await query(
    `SELECT t.id, t.name
       FROM tenant_settings s
       JOIN tenants t ON t.id = s.tenant_id
      WHERE s.key = $1 AND s.value->>'accountId' = $2
      LIMIT 1`,
    [`channel:${channel}`, accountId],
  );
  if (rows[0]) return { id: rows[0].id, name: rows[0].name };
  // Single-tenant fallback so a test number works before per-tenant routing is configured.
  const { rows: only } = await query(
    `SELECT t.id, t.name FROM tenants t WHERE t.status='active' AND t.mode='production'
      ORDER BY t.created_at LIMIT 2`,
  );
  return only.length === 1 ? { id: only[0].id, name: only[0].name } : null;
}

/** Records the raw delivery first, so a replay is detectable before any parsing. */
async function rememberEvent(channel: string, eventId: string, payload: unknown): Promise<boolean> {
  const { rows } = await query(
    `INSERT INTO webhook_events (channel, provider_event_id, payload)
     VALUES ($1,$2,$3) ON CONFLICT (channel, provider_event_id) DO NOTHING RETURNING id`,
    [channel, eventId, JSON.stringify(payload)],
  );
  return rows.length > 0;
}

export async function registerWebhooks(app: FastifyInstance): Promise<void> {
  const cfg = env();

  // ------------------------------------------------------------- WhatsApp ----
  app.get("/webhooks/whatsapp", async (req, reply) => {
    const q = req.query as Record<string, string>;
    const token = cfg.WHATSAPP_VERIFY_TOKEN;
    if (!token) return reply.code(503).send("WhatsApp verify token not configured");
    const res = verifyChallenge(
      { mode: q["hub.mode"], token: q["hub.verify_token"], challenge: q["hub.challenge"] },
      token,
    );
    if (!res.ok) return reply.code(403).send("verification failed");
    return reply.type("text/plain").send(res.challenge);
  });

  app.post("/webhooks/whatsapp", async (req: RawRequest, reply) => {
    const secret = cfg.WHATSAPP_APP_SECRET;
    if (!secret) {
      // Refuse rather than accept unauthenticated traffic on a production endpoint.
      return reply.code(503).send({ error: "whatsapp_not_configured" });
    }
    const raw = req.rawBody ?? Buffer.from(JSON.stringify(req.body ?? {}));
    const sig = req.headers["x-hub-signature-256"] as string | undefined;
    if (!verifySignature(raw, sig, secret)) {
      app.log.warn({ ip: req.ip }, "whatsapp webhook signature rejected");
      return reply.code(401).send({ error: "bad_signature" });
    }

    // Always 200 quickly: Meta retries aggressively on anything else.
    reply.code(200).send({ received: true });
    await processWhatsApp(app, req.body).catch((e) => app.log.error({ err: e }, "whatsapp processing failed"));
  });

  // ------------------------------------------------------------ Instagram ----
  app.get("/webhooks/instagram", async (req, reply) => {
    const q = req.query as Record<string, string>;
    const token = cfg.INSTAGRAM_VERIFY_TOKEN;
    if (!token) return reply.code(503).send("Instagram verify token not configured");
    const res = verifyChallenge(
      { mode: q["hub.mode"], token: q["hub.verify_token"], challenge: q["hub.challenge"] },
      token,
    );
    if (!res.ok) return reply.code(403).send("verification failed");
    return reply.type("text/plain").send(res.challenge);
  });

  app.post("/webhooks/instagram", async (req: RawRequest, reply) => {
    const secret = cfg.INSTAGRAM_APP_SECRET;
    if (!secret) return reply.code(503).send({ error: "instagram_not_configured" });
    const raw = req.rawBody ?? Buffer.from(JSON.stringify(req.body ?? {}));
    const sig = req.headers["x-hub-signature-256"] as string | undefined;
    if (!verifySignature(raw, sig, secret)) return reply.code(401).send({ error: "bad_signature" });

    reply.code(200).send({ received: true });
    await processInstagram(app, req.body).catch((e) => app.log.error({ err: e }, "instagram processing failed"));
  });

  // ------------------------------------------------------- missed call -------
  // A mobile SIM cannot call this. It expects a CPaaS/VoIP layer in front of the
  // client's number; until one exists the channel stays NOT_CONNECTED.
  app.post("/webhooks/voice/missed-call", async (req: RawRequest, reply) => {
    const secret = cfg.VOICE_WEBHOOK_SECRET;
    if (!secret) return reply.code(503).send({ error: "voice_not_configured" });
    const raw = req.rawBody ?? Buffer.from(JSON.stringify(req.body ?? {}));
    const provided = (req.headers["x-kirmi-signature"] as string | undefined) ?? "";
    const digest = createHmac("sha256", secret).update(raw).digest("hex");
    const a = Buffer.from(digest);
    const b = Buffer.from(provided);
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      return reply.code(401).send({ error: "bad_signature" });
    }

    const body = (req.body ?? {}) as { callId?: string; from?: string; to?: string; status?: string };
    if (!body.callId || !body.from || !body.to) return reply.code(400).send({ error: "missing_fields" });
    if (body.status && !["no-answer", "busy", "failed", "missed"].includes(body.status)) {
      return reply.code(200).send({ ignored: true });
    }

    const fresh = await rememberEvent("voice", body.callId, body);
    if (!fresh) return reply.code(200).send({ duplicate: true });

    const tenant = await tenantForAccount("voice", body.to);
    if (!tenant) return reply.code(202).send({ unrouted: true });

    // A missed call becomes an outbound WhatsApp opener — the recovery the brief describes.
    await withTenant(tenant.id, async (db) => {
      await ingestInbound(
        db,
        tenant.id,
        {
          channel: "whatsapp",
          providerMessageId: `missedcall:${body.callId}`,
          from: body.from!,
          to: body.to!,
          text: "[missed call]",
          displayName: null,
          timestamp: new Date(),
          raw: body as Record<string, unknown>,
        },
        { companyName: tenant.name },
      );
      await audit({ tenantId: tenant.id, actor: "system", action: "voice.missed_call", entity: "call", entityId: body.callId!, data: { from: body.from } }, db);
    });
    return reply.code(200).send({ ok: true });
  });

  // --------------------------------------------------------- payments --------
  app.post("/webhooks/payments/stripe", async (req: RawRequest, reply) => {
    const secret = cfg.STRIPE_WEBHOOK_SECRET;
    if (!secret) return reply.code(503).send({ error: "payments_not_configured" });
    const { handleStripeWebhook } = await import("../domain/payments.js");
    const raw = req.rawBody ?? Buffer.from(JSON.stringify(req.body ?? {}));
    const sig = (req.headers["stripe-signature"] as string | undefined) ?? "";
    const out = await handleStripeWebhook(raw, sig, secret);
    return reply.code(out.ok ? 200 : 400).send(out);
  });
}

/**
 * Receiving a signed webhook proves only that INBOUND works. A channel is CONNECTED
 * solely when it can also send — otherwise it is CONFIGURING, and the console says so.
 * Marking it CONNECTED on inbound alone is how a system ends up claiming an integration
 * it does not have.
 */
async function markChannelState(
  db: Parameters<typeof setIntegrationState>[0],
  tenantId: string,
  channel: "whatsapp" | "instagram",
  outboundConfigured: boolean,
): Promise<void> {
  if (outboundConfigured) {
    await setIntegrationState(db, tenantId, channel, "CONNECTED", {
      detail: "Receiving inbound messages and able to send.",
    });
    return;
  }
  await setIntegrationState(db, tenantId, channel, "CONFIGURING", {
    detail: "Inbound webhook verified and receiving. Outbound is not configured, so replies are queued, not sent.",
    requirements: [`${channel === "whatsapp" ? "WHATSAPP" : "INSTAGRAM"}_ACCESS_TOKEN`,
                   channel === "whatsapp" ? "WHATSAPP_PHONE_NUMBER_ID" : "INSTAGRAM_ACCOUNT_ID"],
  });
}

async function processWhatsApp(app: FastifyInstance, body: unknown): Promise<void> {
  const parsed = parseWebhook(body);

  for (const m of parsed.messages) {
    const fresh = await rememberEvent("whatsapp", m.providerMessageId, m.raw);
    if (!fresh) continue;
    const tenant = await tenantForAccount("whatsapp", m.to);
    if (!tenant) {
      app.log.warn({ to: m.to }, "whatsapp message for an unrouted account");
      continue;
    }
    await withTenant(tenant.id, async (db) => {
      await ingestInbound(db, tenant.id, m, { companyName: tenant.name });
      await markChannelState(db, tenant.id, "whatsapp", new WhatsAppCloudProvider().isConfigured());
    });
  }

  for (const s of parsed.statuses) {
    await query(
      `UPDATE messages SET status = $2
        WHERE provider_message_id = $1 AND status <> 'read'`,
      [s.providerMessageId, s.status === "read" ? "read" : s.status === "delivered" ? "delivered" : "sent"],
    );
  }
}

async function processInstagram(app: FastifyInstance, body: unknown): Promise<void> {
  const msgs = parseInstagramWebhook(body);
  for (const m of msgs) {
    const fresh = await rememberEvent("instagram", m.providerMessageId, m.raw);
    if (!fresh) continue;
    const tenant = await tenantForAccount("instagram", m.to);
    if (!tenant) {
      app.log.warn({ to: m.to }, "instagram message for an unrouted account");
      continue;
    }
    await withTenant(tenant.id, async (db) => {
      await ingestInbound(db, tenant.id, m, { companyName: tenant.name });
      await markChannelState(db, tenant.id, "instagram", new InstagramProvider().isConfigured());
    });
  }
}

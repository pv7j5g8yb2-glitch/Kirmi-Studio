import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { createHmac } from "node:crypto";
import { resetDb, createTenant, asTenant } from "./helpers.js";
import { closePool, query, withTenant } from "../src/db/index.js";
import { resetEnvCache } from "../src/config/env.js";
import { createVehicle } from "../src/domain/vehicles.js";
import { setSetting } from "../src/domain/settings.js";
import { verifySignature, verifyChallenge, parseWebhook } from "../src/channels/whatsapp/provider.js";
import { parseInstagramWebhook } from "../src/channels/instagram/provider.js";
import { toMinor } from "../src/core/money.js";
import { createUser } from "../src/core/auth.js";
import type { FastifyInstance } from "fastify";

const APP_SECRET = "test-app-secret";
const VERIFY_TOKEN = "test-verify-token";

function sign(body: string, secret = APP_SECRET): string {
  return "sha256=" + createHmac("sha256", secret).update(body).digest("hex");
}

function cloudMessage(text: string, id: string, phoneNumberId = "PHONE_ID_1") {
  return {
    object: "whatsapp_business_account",
    entry: [{
      id: "WABA_ID",
      changes: [{
        field: "messages",
        value: {
          metadata: { phone_number_id: phoneNumberId, display_phone_number: "971500000000" },
          contacts: [{ wa_id: "971509998877", profile: { name: "Omar" } }],
          messages: [{ id, from: "971509998877", timestamp: String(Math.floor(Date.now() / 1000)), type: "text", text: { body: text } }],
        },
      }],
    }],
  };
}

describe("WhatsApp webhook security (pure functions)", () => {
  it("accepts a correct signature over the raw bytes", () => {
    const body = JSON.stringify({ hello: "world" });
    expect(verifySignature(body, sign(body), APP_SECRET)).toBe(true);
  });

  it("rejects a tampered body", () => {
    const body = JSON.stringify({ hello: "world" });
    const sig = sign(body);
    expect(verifySignature(JSON.stringify({ hello: "evil" }), sig, APP_SECRET)).toBe(false);
  });

  it("rejects a signature made with the wrong secret", () => {
    const body = JSON.stringify({ a: 1 });
    expect(verifySignature(body, sign(body, "other-secret"), APP_SECRET)).toBe(false);
  });

  it("rejects a missing or malformed header", () => {
    const body = "{}";
    expect(verifySignature(body, undefined, APP_SECRET)).toBe(false);
    expect(verifySignature(body, "sha256=short", APP_SECRET)).toBe(false);
  });

  it("completes Meta's subscribe handshake only with the right token", () => {
    expect(verifyChallenge({ mode: "subscribe", token: VERIFY_TOKEN, challenge: "1234" }, VERIFY_TOKEN))
      .toEqual({ ok: true, challenge: "1234" });
    expect(verifyChallenge({ mode: "subscribe", token: "wrong", challenge: "1234" }, VERIFY_TOKEN))
      .toEqual({ ok: false });
  });

  it("parses text, interactive replies and statuses out of the Cloud envelope", () => {
    const parsed = parseWebhook(cloudMessage("hello there", "wamid.1"));
    expect(parsed.messages).toHaveLength(1);
    expect(parsed.messages[0]!.text).toBe("hello there");
    expect(parsed.messages[0]!.from).toBe("971509998877");
    expect(parsed.messages[0]!.displayName).toBe("Omar");
    expect(parsed.messages[0]!.to).toBe("PHONE_ID_1");

    const withStatus = {
      entry: [{ changes: [{ value: { metadata: { phone_number_id: "P" }, statuses: [{ id: "wamid.x", status: "delivered" }] } }] }],
    };
    expect(parseWebhook(withStatus).statuses).toEqual([{ providerMessageId: "wamid.x", status: "delivered" }]);
  });

  it("ignores our own Instagram echoes so the engine cannot answer itself", () => {
    const echo = { entry: [{ id: "IG", messaging: [{ sender: { id: "S" }, recipient: { id: "IG" }, message: { mid: "m1", text: "hi", is_echo: true } }] }] };
    expect(parseInstagramWebhook(echo)).toHaveLength(0);
    const real = { entry: [{ id: "IG", messaging: [{ sender: { id: "S" }, recipient: { id: "IG" }, message: { mid: "m2", text: "hi" } }] }] };
    expect(parseInstagramWebhook(real)).toHaveLength(1);
  });
});

describe("HTTP surface", () => {
  let app: FastifyInstance;
  let tenantId: string;

  beforeAll(async () => {
    process.env.WHATSAPP_APP_SECRET = APP_SECRET;
    process.env.WHATSAPP_VERIFY_TOKEN = VERIFY_TOKEN;
    resetEnvCache();
    const { buildServer } = await import("../src/server.js");
    app = await buildServer();
    await app.ready();
  });

  beforeEach(async () => {
    await resetDb();
    tenantId = await createTenant({ slug: "deiz-http", name: "DEIZ Rental", mode: "production" });
    await withTenant(tenantId, async (db) => {
      await setSetting(db, tenantId, "channel:whatsapp", { accountId: "PHONE_ID_1" }, "client_provided");
      await createVehicle(db, tenantId, {
        make: "Mercedes-Benz", model: "G63 AMG", year: 2024, category: "suv", plate: null,
        dailyRate: toMinor(2500), weeklyRate: null, monthlyRate: null, deposit: toMinor(5000),
        dailyKm: 250, extraKmRate: toMinor(3), minAge: 25, minDays: 1,
      });
    });
  });

  afterAll(async () => { await app.close(); await closePool(); });

  it("serves health and readiness", async () => {
    const h = await app.inject({ method: "GET", url: "/healthz" });
    expect(h.statusCode).toBe(200);
    expect(h.json().ok).toBe(true);
    const r = await app.inject({ method: "GET", url: "/readyz" });
    expect(r.statusCode).toBe(200);
  });

  it("answers Meta's verification challenge", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=${VERIFY_TOKEN}&hub.challenge=98765`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe("98765");
  });

  it("refuses a verification challenge with the wrong token", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=nope&hub.challenge=1",
    });
    expect(res.statusCode).toBe(403);
  });

  it("rejects an unsigned webhook", async () => {
    const res = await app.inject({
      method: "POST", url: "/webhooks/whatsapp",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify(cloudMessage("hi", "wamid.unsigned")),
    });
    expect(res.statusCode).toBe(401);
  });

  it("accepts a signed webhook and drives the full loop into a queued reply", async () => {
    const body = JSON.stringify(cloudMessage("how much for the G63 tomorrow for 3 days", "wamid.live1"));
    const res = await app.inject({
      method: "POST", url: "/webhooks/whatsapp",
      headers: { "content-type": "application/json", "x-hub-signature-256": sign(body) },
      payload: body,
    });
    expect(res.statusCode).toBe(200);

    // processing continues after the 200; give it a moment
    await new Promise((r) => setTimeout(r, 400));

    const out = await asTenant(tenantId, async (db) => {
      const { rows: msgs } = await db.query(`SELECT direction, body FROM messages WHERE tenant_id=$1 ORDER BY created_at`, [tenantId]);
      const { rows: ob } = await db.query(`SELECT status, to_address, body FROM outbox WHERE tenant_id=$1`, [tenantId]);
      const { rows: q } = await db.query(`SELECT total FROM quotes WHERE tenant_id=$1`, [tenantId]);
      return { msgs, ob, q };
    });

    expect(out.msgs.filter((m: any) => m.direction === "inbound")).toHaveLength(1);
    expect(out.msgs.filter((m: any) => m.direction === "outbound")).toHaveLength(1);
    expect(out.ob).toHaveLength(1);
    expect(out.ob[0].to_address).toBe("971509998877");
    expect(out.ob[0].body).toMatch(/G63/);
    expect(out.q).toHaveLength(1);
    // 3 x 2500 + 5% VAT
    expect(out.q[0].total).toBe(toMinor(7875));
  });

  it("is idempotent when Meta retries the same delivery", async () => {
    const body = JSON.stringify(cloudMessage("G63 tomorrow for 2 days", "wamid.retry1"));
    const headers = { "content-type": "application/json", "x-hub-signature-256": sign(body) };
    await app.inject({ method: "POST", url: "/webhooks/whatsapp", headers, payload: body });
    await new Promise((r) => setTimeout(r, 300));
    await app.inject({ method: "POST", url: "/webhooks/whatsapp", headers, payload: body });
    await new Promise((r) => setTimeout(r, 300));

    const counts = await asTenant(tenantId, async (db) => {
      const { rows } = await db.query(
        `SELECT
           (SELECT count(*)::int FROM messages WHERE tenant_id=$1 AND direction='inbound') AS inbound,
           (SELECT count(*)::int FROM outbox WHERE tenant_id=$1) AS outbox`,
        [tenantId],
      );
      return rows[0];
    });
    expect(counts.inbound).toBe(1);
    expect(counts.outbox).toBe(1);

    const { rows: events } = await query(`SELECT count(*)::int AS n FROM webhook_events WHERE channel='whatsapp'`);
    expect(events[0].n).toBe(1);
  });

  it("returns 503 rather than accepting unauthenticated traffic when a channel is unconfigured", async () => {
    const res = await app.inject({ method: "POST", url: "/webhooks/voice/missed-call", payload: {} });
    expect(res.statusCode).toBe(503);
  });

  it("requires authentication on tenant APIs", async () => {
    const res = await app.inject({ method: "GET", url: `/api/tenants/${tenantId}/overview` });
    expect(res.statusCode).toBe(401);
  });

  it("refuses a principal access to a tenant they are not a member of", async () => {
    const otherTenant = await createTenant({ slug: "other-co" });
    await createUser({ email: "only-deiz@x.com", name: "Scoped", password: "pw-123456", role: "client_admin", tenantIds: [tenantId] });

    const login = await app.inject({
      method: "POST", url: "/api/auth/login",
      payload: { email: "only-deiz@x.com", password: "pw-123456" },
    });
    expect(login.statusCode).toBe(200);
    const cookie = login.headers["set-cookie"] as string;

    const own = await app.inject({ method: "GET", url: `/api/tenants/${tenantId}/overview`, headers: { cookie } });
    expect(own.statusCode).toBe(200);

    const forbidden = await app.inject({ method: "GET", url: `/api/tenants/${otherTenant}/overview`, headers: { cookie } });
    expect(forbidden.statusCode).toBe(403);
  });

  it("rejects a bad password without revealing whether the account exists", async () => {
    await createUser({ email: "real@x.com", name: "Real", password: "pw-123456", role: "client_admin", tenantIds: [tenantId] });
    const wrongPw = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "real@x.com", password: "nope" } });
    const noUser = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "ghost@x.com", password: "nope" } });
    expect(wrongPw.statusCode).toBe(401);
    expect(noUser.statusCode).toBe(401);
    expect(wrongPw.json().message).toBe(noUser.json().message);
  });
});

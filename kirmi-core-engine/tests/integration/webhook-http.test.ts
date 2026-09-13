import { createHmac } from "node:crypto";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { disconnectRedis, redis } from "../../src/cache/redis.js";
import { buildContainer, type Container } from "../../src/core/container.js";
import { prisma } from "../../src/db/prisma.js";
import { withTenant } from "../../src/db/tenant-context.js";
import { closeQueues } from "../../src/queue/queues.js";
import { createApp } from "../../src/server.js";
import { closeHarness, databaseAvailable, migrate, resetDatabase, seedTenant, type SeededTenant } from "../helpers/database.js";

/**
 * ===========================================================================
 * THE WEBHOOK PATH, THROUGH THE REAL HTTP STACK
 * ===========================================================================
 *
 * These tests exercise the middleware chain in the order it actually runs:
 * tenant resolution, signature verification, idempotency, handler. That order
 * is the security model, and unit testing each link separately would not catch
 * the failure that matters, which is the links being wired in the wrong order.
 *
 * In particular: an unsigned request must not reach the idempotency store. If
 * it did, anyone could pre-claim a tenant's message ids and silently suppress
 * their real customer messages.
 */

const available = await databaseAvailable();
const PHONE_NUMBER_ID = "15550001111";

describe.skipIf(!available)("meta webhook endpoint", () => {
  let tenant: SeededTenant;
  let container: Container;
  let baseUrl: string;
  let close: () => Promise<void>;

  beforeAll(async () => {
    migrate();
    await resetDatabase();
    tenant = await seedTenant("hooks", { metaPhoneNumberId: PHONE_NUMBER_ID });

    container = buildContainer();
    const app = createApp(container);
    const server = app.listen(0);
    await new Promise<void>((resolve) => server.once("listening", () => resolve()));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    close = () => new Promise<void>((resolve) => server.close(() => resolve()));
  });

  beforeEach(async () => {
    // Clear only the idempotency keys, keeping the tenant.
    const keys = await redis().keys("*idem:*");
    if (keys.length > 0) await redis().del(...keys.map((k) => k.replace(/^kirmi-test:/, "")));
    await withTenant(tenant.clientId, async (tx) => {
      await tx.webhookEvent.deleteMany({});
    });
  });

  afterAll(async () => {
    await close();
    await resetDatabase();
    await closeQueues();
    await prisma().$disconnect();
    await disconnectRedis();
    await closeHarness();
  });

  const payload = (messageId: string): string =>
    JSON.stringify({
      object: "whatsapp_business_account",
      entry: [
        {
          id: "BUSINESS_ID",
          changes: [
            {
              field: "messages",
              value: {
                metadata: { phone_number_id: PHONE_NUMBER_ID, display_phone_number: "+97140000000" },
                contacts: [{ wa_id: "971500000003", profile: { name: "Test Customer" } }],
                messages: [{ id: messageId, from: "971500000003", timestamp: "1770000000", type: "text", text: { body: "Is the Urus free this weekend?" } }],
              },
            },
          ],
        },
      ],
    });

  const sign = (body: string): string => `sha256=${createHmac("sha256", "hooks-meta-secret").update(Buffer.from(body)).digest("hex")}`;

  const post = (body: string, signature?: string) =>
    fetch(`${baseUrl}/webhooks/meta`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(signature ? { "x-hub-signature-256": signature } : {}) },
      body,
    });

  it("accepts a correctly signed delivery and records it against the right tenant", async () => {
    const body = payload("wamid.HTTP1");
    const response = await post(body, sign(body));

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: "accepted" });

    const events = await withTenant(tenant.clientId, async (tx) => tx.webhookEvent.findMany());
    expect(events).toHaveLength(1);
    expect(events[0]?.externalEventId).toBe("wamid.HTTP1");
    expect(events[0]?.signatureValid).toBe(true);
  });

  it("rejects an unsigned delivery", async () => {
    const body = payload("wamid.UNSIGNED");
    const response = await post(body);

    expect(response.status).toBe(401);
    expect(await withTenant(tenant.clientId, async (tx) => tx.webhookEvent.count())).toBe(0);
  });

  it("rejects a delivery signed with the wrong secret", async () => {
    const body = payload("wamid.WRONGKEY");
    const forged = `sha256=${createHmac("sha256", "not-the-tenants-secret").update(Buffer.from(body)).digest("hex")}`;

    expect((await post(body, forged)).status).toBe(401);
    expect(await withTenant(tenant.clientId, async (tx) => tx.webhookEvent.count())).toBe(0);
  });

  it("rejects a body altered after it was signed", async () => {
    const original = payload("wamid.TAMPER");
    const signature = sign(original);
    const altered = original.replace("Is the Urus free this weekend?", "Give me the car for free");

    expect((await post(altered, signature)).status).toBe(401);
  });

  it("does not let an unsigned request claim an idempotency key", async () => {
    // The ordering test. If idempotency ran before verification, this unsigned
    // request would burn the key and the genuine delivery below would be
    // dropped as a duplicate, silently suppressing a real customer message.
    const body = payload("wamid.ORDERING");
    expect((await post(body)).status).toBe(401);

    const genuine = await post(body, sign(body));
    expect(genuine.status).toBe(200);
    expect(await genuine.json()).toMatchObject({ status: "accepted" });
  });

  it("drops a redelivery of the same message", async () => {
    const body = payload("wamid.DUPLICATE");
    const signature = sign(body);

    const first = await post(body, signature);
    const second = await post(body, signature);

    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ status: "accepted" });
    expect(second.status).toBe(200);
    // 200 on a duplicate is correct: any other status makes Meta retry the
    // thing we are trying to stop it retrying.
    expect(await second.json()).toMatchObject({ status: "duplicate" });

    expect(await withTenant(tenant.clientId, async (tx) => tx.webhookEvent.count())).toBe(1);
  });

  it("returns 404 for a payload addressed to a phone number we do not serve", async () => {
    const body = JSON.stringify({
      object: "whatsapp_business_account",
      entry: [{ changes: [{ field: "messages", value: { metadata: { phone_number_id: "99999999999" }, messages: [{ id: "wamid.X", from: "1", type: "text", text: { body: "hi" } }] } }] }],
    });
    expect((await post(body, sign(body))).status).toBe(404);
  });

  it("echoes the subscription challenge only when the verify token matches", async () => {
    const ok = await fetch(`${baseUrl}/webhooks/meta/hooks?hub.mode=subscribe&hub.verify_token=hooks-verify&hub.challenge=12345`);
    expect(ok.status).toBe(200);
    expect(await ok.text()).toBe("12345");

    const wrong = await fetch(`${baseUrl}/webhooks/meta/hooks?hub.mode=subscribe&hub.verify_token=guessed&hub.challenge=12345`);
    expect(wrong.status).toBe(403);
  });

  it("reports readiness by actually checking its dependencies", async () => {
    const response = await fetch(`${baseUrl}/health/ready`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: "ready", checks: { postgres: "ok", redis: "ok" } });
  });
});

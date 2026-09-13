import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createIdempotencyStore } from "../../src/cache/idempotency.js";
import { disconnectRedis, redis } from "../../src/cache/redis.js";
import { redisAvailable } from "../helpers/database.js";

/**
 * ===========================================================================
 * DUPLICATE SUPPRESSION
 * ===========================================================================
 *
 * Meta redelivers whenever our acknowledgement is slow or lost. Without this
 * guard, one delayed 200 becomes two quotes to the same customer, or two holds
 * on the same car by the same person, the second of which blocks a genuine
 * booking until it expires.
 *
 * Run against a real Redis, because the property under test is the atomicity of
 * SET NX. A fake that returns "already claimed" when asked twice proves nothing
 * about what happens when two workers ask at the same instant.
 */

const available = await redisAvailable();

describe.skipIf(!available)("idempotency interceptor", () => {
  const store = createIdempotencyStore();
  const clientA = "11111111-1111-4111-8111-111111111111";
  const clientB = "22222222-2222-4222-8222-222222222222";

  beforeEach(async () => {
    const keys = await redis().keys("*idem:*");
    if (keys.length > 0) {
      // keyPrefix is applied on write, so strip it before deleting.
      await redis().del(...keys.map((k) => k.replace(/^kirmi-test:/, "")));
    }
  });

  afterAll(async () => {
    await disconnectRedis();
  });

  it("claims an event id once and refuses it thereafter", async () => {
    const first = await store.claim(clientA, "meta", "wamid.ABC123");
    const second = await store.claim(clientA, "meta", "wamid.ABC123");

    expect(first.claimed).toBe(true);
    expect(second.claimed).toBe(false);
    if (!second.claimed) expect(second.firstSeenAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("lets exactly one of twenty concurrent claims through", async () => {
    // The atomicity test. A GET followed by a SET has a window between them,
    // and twenty workers racing through that window all think they are first.
    const attempts = await Promise.all(
      Array.from({ length: 20 }, () => store.claim(clientA, "meta", "wamid.CONCURRENT")),
    );
    expect(attempts.filter((a) => a.claimed)).toHaveLength(1);
  });

  it("keys claims per tenant, so two clients can carry the same carrier id", async () => {
    const a = await store.claim(clientA, "meta", "wamid.SHARED");
    const b = await store.claim(clientB, "meta", "wamid.SHARED");
    expect(a.claimed).toBe(true);
    expect(b.claimed).toBe(true);
  });

  it("keys claims per provider, so a Twilio sid cannot mask a Meta message", async () => {
    expect((await store.claim(clientA, "meta", "SHARED-ID")).claimed).toBe(true);
    expect((await store.claim(clientA, "twilio", "SHARED-ID")).claimed).toBe(true);
  });

  it("lets a carrier retry through after a processing failure released the claim", async () => {
    // The failure case that matters. Holding the key after a transient error
    // turns a retryable blip into a permanently lost enquiry, which is the more
    // expensive of the two mistakes: a duplicate reply is embarrassing, a lost
    // enquiry is lost revenue.
    expect((await store.claim(clientA, "meta", "wamid.FAILED")).claimed).toBe(true);
    await store.release(clientA, "meta", "wamid.FAILED");
    expect((await store.claim(clientA, "meta", "wamid.FAILED")).claimed).toBe(true);
  });

  it("expires a claim so the key space does not grow without bound", async () => {
    await store.claim(clientA, "meta", "wamid.TTL", 60);
    const ttl = await redis().ttl(`idem:${clientA}:meta:wamid.TTL`);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(60);
  });
});

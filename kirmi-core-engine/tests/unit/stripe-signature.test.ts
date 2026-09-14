import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifyStripeSignature } from "../../src/middleware/signature.middleware.js";

/**
 * Stripe signature verification.
 *
 * Held to a higher bar than the other webhooks in this engine, because of what
 * a forged one does. A forged Meta message produces a wrong reply to one
 * customer. A forged Stripe event marks a car as paid for, takes it off the
 * market, and puts a line on a client's commission invoice for money that
 * never arrived.
 */

const SECRET = "whsec_test_secret";
const NOW = new Date("2026-09-14T12:00:00Z");

function sign(body: string, at: Date = NOW, secret = SECRET): string {
  const t = Math.floor(at.getTime() / 1000);
  const v1 = createHmac("sha256", secret).update(`${t}.${body}`).digest("hex");
  return `t=${t},v1=${v1}`;
}

describe("stripe signature", () => {
  const body = JSON.stringify({ id: "evt_1", type: "checkout.session.completed" });

  it("accepts a correctly signed, current event", () => {
    expect(verifyStripeSignature(Buffer.from(body), sign(body), SECRET, NOW)).toBe(true);
  });

  it("rejects a signature made with a different secret", () => {
    const forged = sign(body, NOW, "whsec_attacker");
    expect(verifyStripeSignature(Buffer.from(body), forged, SECRET, NOW)).toBe(false);
  });

  it("rejects a body that was altered after signing", () => {
    // The exact attack that matters: take a real event and change the amount.
    const header = sign(body);
    const tampered = JSON.stringify({ id: "evt_1", type: "checkout.session.completed", extra: true });
    expect(verifyStripeSignature(Buffer.from(tampered), header, SECRET, NOW)).toBe(false);
  });

  it("rejects a replay from outside the tolerance window", () => {
    const old = new Date(NOW.getTime() - 10 * 60 * 1000);
    expect(verifyStripeSignature(Buffer.from(body), sign(body, old), SECRET, NOW)).toBe(false);
  });

  it("accepts one just inside the window", () => {
    const recent = new Date(NOW.getTime() - 4 * 60 * 1000);
    expect(verifyStripeSignature(Buffer.from(body), sign(body, recent), SECRET, NOW)).toBe(true);
  });

  it("accepts either signature during a secret rotation", () => {
    // Stripe sends every valid v1 while two secrets are live. Rejecting the
    // second would drop real payments for the length of a rotation.
    const t = Math.floor(NOW.getTime() / 1000);
    const wrong = createHmac("sha256", "whsec_old").update(`${t}.${body}`).digest("hex");
    const right = createHmac("sha256", SECRET).update(`${t}.${body}`).digest("hex");
    const header = `t=${t},v1=${wrong},v1=${right}`;
    expect(verifyStripeSignature(Buffer.from(body), header, SECRET, NOW)).toBe(true);
  });

  it("rejects a missing or malformed header rather than trusting it", () => {
    expect(verifyStripeSignature(Buffer.from(body), undefined, SECRET, NOW)).toBe(false);
    expect(verifyStripeSignature(Buffer.from(body), "nonsense", SECRET, NOW)).toBe(false);
    expect(verifyStripeSignature(Buffer.from(body), `t=${Math.floor(NOW.getTime() / 1000)}`, SECRET, NOW)).toBe(false);
  });
});

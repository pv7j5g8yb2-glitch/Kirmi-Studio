import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  decryptSecret,
  encryptSecret,
  generateApiKey,
  parseApiKey,
  safeEqual,
  verifyMetaSignature,
  verifyTwilioSignature,
} from "../../src/core/crypto.js";

/**
 * A webhook endpoint without working signature verification is an open relay
 * that makes a real business text real customers. These tests are the proof
 * that the door is shut, including the tampering cases that matter.
 */
describe("Meta signature verification", () => {
  const secret = "meta-app-secret";
  const body = Buffer.from(JSON.stringify({ object: "whatsapp_business_account", entry: [{ id: "1" }] }));
  const valid = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;

  it("accepts a genuine signature", () => {
    expect(verifyMetaSignature(body, valid, secret)).toBe(true);
  });

  it("rejects a body that was altered after signing", () => {
    const tampered = Buffer.from(JSON.stringify({ object: "whatsapp_business_account", entry: [{ id: "2" }] }));
    expect(verifyMetaSignature(tampered, valid, secret)).toBe(false);
  });

  it("rejects a signature produced with a different tenant's secret", () => {
    const otherTenant = `sha256=${createHmac("sha256", "someone-elses-secret").update(body).digest("hex")}`;
    expect(verifyMetaSignature(body, otherTenant, secret)).toBe(false);
  });

  it("rejects a missing header rather than defaulting to trust", () => {
    expect(verifyMetaSignature(body, undefined, secret)).toBe(false);
    expect(verifyMetaSignature(body, "", secret)).toBe(false);
  });

  it("rejects a correct digest sent without the sha256= prefix", () => {
    const bare = createHmac("sha256", secret).update(body).digest("hex");
    expect(verifyMetaSignature(body, bare, secret)).toBe(false);
  });

  it("verifies the raw bytes, not a re-serialised object", () => {
    // Same data, different key order: what JSON.stringify would produce after a
    // parse. Meta signed the original bytes, so only those bytes verify.
    const original = Buffer.from('{"a":1,"b":2}');
    const signature = `sha256=${createHmac("sha256", secret).update(original).digest("hex")}`;
    const reserialised = Buffer.from(JSON.stringify({ b: 2, a: 1 }));

    expect(verifyMetaSignature(original, signature, secret)).toBe(true);
    expect(verifyMetaSignature(reserialised, signature, secret)).toBe(false);
  });
});

describe("Twilio signature verification", () => {
  const token = "twilio-auth-token";
  const url = "https://api.kirmi.studio/webhooks/twilio/voice";
  const params = { CallSid: "CA123", From: "+971500000000", To: "+97140000000", CallStatus: "no-answer" };

  /** Twilio's documented scheme: HMAC-SHA1 over url + params sorted by key. */
  const sign = (u: string, p: Record<string, string>): string =>
    createHmac("sha1", token)
      .update(Object.keys(p).sort().reduce((acc, k) => acc + k + (p[k] ?? ""), u))
      .digest("base64");

  it("accepts a genuine Twilio signature", () => {
    expect(verifyTwilioSignature(url, params, sign(url, params), token)).toBe(true);
  });

  it("rejects a signature for a different URL", () => {
    expect(verifyTwilioSignature(url, params, sign("https://evil.example/webhooks", params), token)).toBe(false);
  });

  it("rejects when a parameter was changed in flight", () => {
    const signature = sign(url, params);
    expect(verifyTwilioSignature(url, { ...params, From: "+971509999999" }, signature, token)).toBe(false);
  });

  it("does not depend on the order parameters arrive in", () => {
    const signature = sign(url, params);
    const reordered = { CallStatus: "no-answer", To: "+97140000000", From: "+971500000000", CallSid: "CA123" };
    expect(verifyTwilioSignature(url, reordered, signature, token)).toBe(true);
  });
});

describe("constant time comparison", () => {
  it("matches identical strings and rejects differing ones", () => {
    expect(safeEqual("abc123", "abc123")).toBe(true);
    expect(safeEqual("abc123", "abc124")).toBe(false);
  });

  it("rejects strings of different lengths without throwing", () => {
    expect(safeEqual("short", "considerably longer")).toBe(false);
  });
});

describe("credential encryption at rest", () => {
  it("round trips a secret", () => {
    const secret = "EAAG...a-real-looking-meta-app-secret";
    expect(decryptSecret(encryptSecret(secret))).toBe(secret);
  });

  it("produces different ciphertext each time, so equal secrets are not detectable", () => {
    expect(encryptSecret("same-secret")).not.toBe(encryptSecret("same-secret"));
  });

  it("refuses to decrypt tampered ciphertext rather than returning rubbish", () => {
    const encoded = encryptSecret("sensitive");
    const parts = encoded.split(".");
    const corrupted = [parts[0], Buffer.from("tampered-payload").toString("base64url"), parts[2]].join(".");
    expect(() => decryptSecret(corrupted)).toThrow();
  });
});

describe("dashboard API keys", () => {
  it("embeds the tenant slug so a key can be routed before it is trusted", () => {
    const key = generateApiKey("deiz");
    const parsed = parseApiKey(key);
    expect(parsed?.slug).toBe("deiz");
    expect(parsed?.prefix).toBe(key.slice(0, 12));
  });

  it("rejects a malformed key", () => {
    expect(parseApiKey("not-a-key")).toBeNull();
    expect(parseApiKey("kirmi_deiz")).toBeNull();
    expect(parseApiKey("kirmi_deiz.short")).toBeNull();
  });
});

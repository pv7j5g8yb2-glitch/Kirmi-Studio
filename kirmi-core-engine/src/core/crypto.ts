import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { API_KEY_PREFIX_LENGTH } from "../config/constants.js";
import { env } from "../config/env.js";
import { ConfigurationError } from "./errors.js";

/**
 * ===========================================================================
 * CRYPTOGRAPHIC PRIMITIVES
 * ===========================================================================
 *
 * Two jobs. Verifying that an inbound webhook really came from Meta or Twilio,
 * and keeping each client's credentials encrypted at rest so a database dump is
 * not a set of working API keys for every tenant at once.
 *
 * Every comparison in this file is constant time. String equality on a MAC
 * leaks the correct value one byte at a time to anyone patient enough to
 * measure, and "nobody would bother" is not a security property.
 */

const AES_ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12; // 96 bits, the size GCM is specified for.
const AUTH_TAG_BYTES = 16;

function encryptionKey(): Buffer {
  const raw = env().SECRETS_ENCRYPTION_KEY;
  if (!raw) {
    throw new ConfigurationError("SECRETS_ENCRYPTION_KEY is not configured, cannot handle client credentials");
  }
  const key = Buffer.from(raw, "base64");
  if (key.length !== 32) {
    throw new ConfigurationError(`SECRETS_ENCRYPTION_KEY must decode to 32 bytes, got ${key.length}`);
  }
  return key;
}

/**
 * Encrypt a client credential for storage.
 * Output is iv.ciphertext.tag, base64url, joined by dots. Self describing, so
 * rotating to a different algorithm later does not need a schema change.
 */
export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(AES_ALGORITHM, encryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv.toString("base64url"), ciphertext.toString("base64url"), tag.toString("base64url")].join(".");
}

export function decryptSecret(encoded: string): string {
  const [ivPart, dataPart, tagPart] = encoded.split(".");
  if (!ivPart || !dataPart || !tagPart) {
    throw new ConfigurationError("Stored secret is malformed");
  }
  const tag = Buffer.from(tagPart, "base64url");
  if (tag.length !== AUTH_TAG_BYTES) throw new ConfigurationError("Stored secret has a bad auth tag");

  const decipher = createDecipheriv(AES_ALGORITHM, encryptionKey(), Buffer.from(ivPart, "base64url"));
  decipher.setAuthTag(tag);
  // GCM authenticates as it decrypts: a tampered ciphertext throws here rather
  // than returning plausible looking rubbish.
  return Buffer.concat([decipher.update(Buffer.from(dataPart, "base64url")), decipher.final()]).toString("utf8");
}

/** Constant time comparison that does not leak length through an early return. */
export function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) {
    // Still burn a comparison so the timing of a length mismatch looks the same
    // as the timing of a content mismatch.
    timingSafeEqual(bufA, bufA);
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

/**
 * Meta's X-Hub-Signature-256: hex HMAC-SHA256 of the exact raw request body,
 * keyed on the app secret, prefixed with "sha256=".
 *
 * "Exact raw body" is the part that catches people out. Verifying against a
 * re-serialised JSON object fails the moment Meta emits a key order or an
 * escape sequence that JSON.stringify would write differently, so the raw
 * bytes are captured by the body parser and carried through untouched.
 */
export function verifyMetaSignature(rawBody: Buffer, headerValue: string | undefined, appSecret: string): boolean {
  if (!headerValue) return false;
  const expected = `sha256=${createHmac("sha256", appSecret).update(rawBody).digest("hex")}`;
  return safeEqual(headerValue.trim(), expected);
}

/**
 * Twilio's X-Twilio-Signature.
 *
 * Worth stating plainly because it differs from Meta: Twilio specifies
 * HMAC-SHA1 over the full request URL with the POST parameters appended in
 * sorted key order, base64 encoded. Implementing this as SHA256 because SHA256
 * sounds stronger produces a checker that rejects every genuine Twilio request,
 * so the algorithm follows Twilio rather than preference.
 *
 * For JSON bodies Twilio signs the URL with a bodySHA256 query parameter and
 * sends no form fields; verifyTwilioBodyHash below covers that case, and there
 * the digest genuinely is SHA256.
 */
export function verifyTwilioSignature(
  url: string,
  params: Record<string, string>,
  headerValue: string | undefined,
  authToken: string,
): boolean {
  if (!headerValue) return false;

  // Sorted by key, concatenated as key then value, with no separators. Twilio's
  // scheme, not ours.
  const payload = Object.keys(params)
    .sort()
    .reduce((acc, key) => acc + key + (params[key] ?? ""), url);

  const expected = createHmac("sha1", authToken).update(Buffer.from(payload, "utf8")).digest("base64");
  return safeEqual(headerValue.trim(), expected);
}

/** The JSON body variant: Twilio puts sha256 of the body in a query parameter. */
export function verifyTwilioBodyHash(rawBody: Buffer, expectedHashHex: string | undefined): boolean {
  if (!expectedHashHex) return false;
  return safeEqual(createHash("sha256").update(rawBody).digest("hex"), expectedHashHex.trim());
}

/** sha256 hex. Used for API key storage and for keying bodies that carry no id. */
export function sha256Hex(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * Dashboard API keys, shaped so they can be routed before they are trusted.
 *
 * The format is kirmi_<slug>.<secret>. Embedding the tenant slug is not
 * decoration: client_api_keys is under row level security like everything else,
 * so looking a key up requires already knowing which tenant to scope to. The
 * slug in the public half answers that from the routing projection, and only
 * then is the secret half compared, in constant time, inside that tenant's
 * scope. No global key table, no hole in the isolation model.
 */
export function generateApiKey(slug: string): string {
  const clean = slug.toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 32) || "client";
  return `kirmi_${clean}.${randomBytes(24).toString("base64url")}`;
}

export interface ParsedApiKey {
  slug: string;
  /** Stored in clear for lookup; proves nothing on its own. */
  prefix: string;
  /** sha256 of the whole key, compared against the stored hash. */
  hash: string;
}

export function parseApiKey(raw: string): ParsedApiKey | null {
  const match = /^kirmi_([a-z0-9-]{1,32})\.([A-Za-z0-9_-]{16,})$/.exec(raw.trim());
  if (!match) return null;
  const [, slug] = match;
  if (!slug) return null;
  return { slug, prefix: raw.slice(0, API_KEY_PREFIX_LENGTH), hash: sha256Hex(raw) };
}

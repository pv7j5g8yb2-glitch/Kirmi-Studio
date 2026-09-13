import { randomBytes, randomUUID } from "node:crypto";
import { ValidationError } from "./errors.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function newId(): string {
  return randomUUID();
}

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

/**
 * Guard for any value on its way into a tenant scoped SQL setting.
 *
 * set_config is called with a bound parameter, so this is not the only thing
 * standing between us and injection. It is here because a clientId that is not
 * a uuid means the caller is confused about what it holds, and a confused
 * caller near the isolation boundary should stop rather than continue.
 */
export function assertUuid(value: unknown, label = "id"): string {
  if (!isUuid(value)) throw new ValidationError(`${label} must be a UUID`, { received: typeof value });
  return value;
}

/** Unambiguous alphabet: no O/0, no I/1, nothing a customer can misread aloud. */
const REFERENCE_ALPHABET = "ACDEFGHJKLMNPQRTUVWXY3479";

/**
 * A booking reference a human can read down a phone line: DEIZ-7QF3M2.
 * Uniqueness is enforced by the database, not hoped for here.
 */
export function bookingReference(prefix: string, length = 6): string {
  const bytes = randomBytes(length);
  let out = "";
  for (let i = 0; i < length; i++) {
    const byte = bytes[i] ?? 0;
    out += REFERENCE_ALPHABET[byte % REFERENCE_ALPHABET.length];
  }
  const cleanPrefix = prefix.toUpperCase().replace(/[^A-Z]/g, "").slice(0, 4) || "KRM";
  return `${cleanPrefix}-${out}`;
}

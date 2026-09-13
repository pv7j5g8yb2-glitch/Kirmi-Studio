import { pino, type Logger } from "pino";
import { env } from "../config/env.js";

/**
 * One logger, redaction configured once.
 *
 * The redaction list is not decoration. This service handles a different Meta
 * app secret and payment key for every tenant, and a log line is the easiest
 * place in the world to leak one. Anything that looks like a credential is
 * censored at the serialiser, so a careless `log.info({ config })` cannot spill
 * a client's secret into a log aggregator.
 */
const REDACTED = [
  "req.headers.authorization",
  "req.headers.cookie",
  "req.headers['x-hub-signature-256']",
  "req.headers['x-twilio-signature']",
  "req.headers['x-api-key']",
  "*.metaAppSecret",
  "*.metaAppSecretEncrypted",
  "*.twilioAuthToken",
  "*.twilioAuthTokenEncrypted",
  "*.paymentAccessKeys",
  "*.secretKeyEncrypted",
  "*.apiKey",
  "*.keyHash",
  "password",
  "secret",
];

let root: Logger | null = null;

export function logger(): Logger {
  if (!root) {
    root = pino({
      level: env().LOG_LEVEL,
      redact: { paths: REDACTED, censor: "[redacted]" },
      base: { service: "kirmi-core-engine" },
      formatters: {
        level: (label) => ({ level: label }),
      },
    });
  }
  return root;
}

/**
 * A child logger bound to one tenant and request. Every line produced downstream
 * carries the clientId, which is what makes "did this happen to DEIZ or to
 * someone else" answerable in one query rather than one afternoon.
 */
export function scopedLogger(bindings: { clientId?: string; requestId?: string; [k: string]: unknown }): Logger {
  return logger().child(bindings);
}

export type { Logger };

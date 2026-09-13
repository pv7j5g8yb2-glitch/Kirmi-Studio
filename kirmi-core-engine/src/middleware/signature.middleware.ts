import type { NextFunction, Request, RequestHandler, Response } from "express";
import { env, isProduction } from "../config/env.js";
import { sha256Hex, verifyMetaSignature, verifyTwilioBodyHash, verifyTwilioSignature } from "../core/crypto.js";
import { SignatureVerificationError } from "../core/errors.js";
import type { ClientConfigService } from "../services/client-config.service.js";
import type { WebhookService } from "../services/webhook.service.js";

/**
 * ===========================================================================
 * CRYPTOGRAPHIC SIGNATURE VERIFICATION
 * ===========================================================================
 *
 * A webhook endpoint is a public URL that causes a business to send messages to
 * its customers. Unverified, it is an open relay: anyone who guesses the URL
 * can make a luxury rental company text arbitrary people, or flood a tenant's
 * ledger with fabricated enquiries that inflate their own invoice.
 *
 * So every inbound payload is authenticated against the tenant's own secret
 * before anything else happens, and specifically before the payload is
 * persisted, queued, or allowed to create any row.
 *
 * Three details carry the weight:
 *
 *   1. The RAW bytes are verified, never a re-serialised object. JSON.stringify
 *      of a parsed body is not byte identical to what was sent, and verifying
 *      against it fails on perfectly genuine traffic.
 *   2. Comparison is constant time (see core/crypto.ts). String equality on a
 *      MAC leaks the correct value to anyone willing to measure.
 *   3. The secret is the TENANT's, looked up after routing. One shared platform
 *      secret would mean any client could forge traffic for any other.
 *
 * A missing per-tenant secret is a hard rejection in production. The fallback to
 * a platform secret exists for local development only, and env() refuses to
 * start production with the unsigned escape hatch enabled at all.
 */

export function verifyMetaWebhook(
  configService: ClientConfigService,
  webhooks: WebhookService,
): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction): void => {
    void (async () => {
      try {
        const clientId = req.routing?.clientId;
        if (!clientId) throw new SignatureVerificationError("Signature check ran before tenant resolution");

        const rawBody = req.rawBody;
        if (!rawBody) throw new SignatureVerificationError("No raw body captured for verification");

        const secrets = await configService.loadSecrets(clientId);
        const appSecret = secrets.metaAppSecret ?? env().META_APP_SECRET ?? null;

        if (!appSecret) {
          if (allowUnsigned()) {
            req.log?.warn({ clientId }, "ALLOW_UNSIGNED_WEBHOOKS is on, skipping Meta signature check");
            next();
            return;
          }
          throw new SignatureVerificationError("No Meta app secret configured for this client", { clientId });
        }

        const header = req.get("x-hub-signature-256");
        if (!verifyMetaSignature(rawBody, header, appSecret)) {
          // Recorded against the tenant, with a hash of the body rather than
          // the body: a rejected payload is untrusted input and storing it
          // verbatim is how a log viewer becomes an attack surface.
          await webhooks.recordRejection(clientId, "meta", "signature_mismatch", sha256Hex(rawBody));
          throw new SignatureVerificationError("Meta signature verification failed", { clientId });
        }

        next();
      } catch (err) {
        next(err);
      }
    })();
  };
}

export function verifyTwilioWebhook(
  configService: ClientConfigService,
  webhooks: WebhookService,
): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction): void => {
    void (async () => {
      try {
        const clientId = req.routing?.clientId;
        if (!clientId) throw new SignatureVerificationError("Signature check ran before tenant resolution");

        const secrets = await configService.loadSecrets(clientId);
        const authToken = secrets.twilioAuthToken ?? env().TWILIO_AUTH_TOKEN ?? null;

        if (!authToken) {
          if (allowUnsigned()) {
            req.log?.warn({ clientId }, "ALLOW_UNSIGNED_WEBHOOKS is on, skipping Twilio signature check");
            next();
            return;
          }
          throw new SignatureVerificationError("No Twilio auth token configured for this client", { clientId });
        }

        // Twilio signs the exact URL it called, including protocol, host and
        // query string. Behind a proxy that is not what Express reconstructs
        // from the socket, so PUBLIC_BASE_URL is the authority.
        const url = new URL(req.originalUrl, env().PUBLIC_BASE_URL).toString();
        const header = req.get("x-twilio-signature");

        const contentType = req.get("content-type") ?? "";
        const isForm = contentType.includes("application/x-www-form-urlencoded");

        const valid = isForm
          ? verifyTwilioSignature(url, req.body as Record<string, string>, header, authToken)
          : // JSON delivery: Twilio signs the URL carrying a bodySHA256 query
            // parameter, so both halves have to check out.
            verifyTwilioSignature(url, {}, header, authToken) &&
            verifyTwilioBodyHash(req.rawBody ?? Buffer.alloc(0), readBodyHash(req));

        if (!valid) {
          await webhooks.recordRejection(clientId, "twilio", "signature_mismatch", sha256Hex(req.rawBody ?? Buffer.alloc(0)));
          throw new SignatureVerificationError("Twilio signature verification failed", { clientId });
        }

        next();
      } catch (err) {
        next(err);
      }
    })();
  };
}

function readBodyHash(req: Request): string | undefined {
  const value = req.query["bodySHA256"];
  return typeof value === "string" ? value : undefined;
}

/** Never true in production: env() refuses to start if it is set there. */
function allowUnsigned(): boolean {
  return env().ALLOW_UNSIGNED_WEBHOOKS && !isProduction();
}

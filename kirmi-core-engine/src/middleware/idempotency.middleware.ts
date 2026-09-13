import type { NextFunction, Request, RequestHandler, Response } from "express";
import type { IdempotencyStore } from "../cache/idempotency.js";

/**
 * ===========================================================================
 * THE IDEMPOTENCY INTERCEPTOR
 * ===========================================================================
 *
 * Meta redelivers whenever our acknowledgement is slow or lost. Twilio does the
 * same. Without this, one delayed 200 becomes two quotes to the same customer,
 * or two holds on the same car by the same person, the second of which blocks a
 * real booking until it expires.
 *
 * The interceptor claims the carrier's own event id atomically in Redis. First
 * claim wins and continues; every later delivery of that id is answered 200 and
 * dropped. Answering 200 is the correct response to a duplicate: it is not an
 * error, and any other status makes the carrier retry the thing we are trying
 * to stop it retrying.
 *
 * This runs AFTER signature verification, always. Claiming keys from
 * unauthenticated requests would let anyone poison the cache and suppress a
 * tenant's real messages by pre-claiming ids.
 */
export function idempotencyGuard(
  store: IdempotencyStore,
  extractEventId: (req: Request) => string | null,
  provider: string,
): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    void (async () => {
      try {
        const clientId = req.routing?.clientId;
        const eventId = extractEventId(req);

        // Nothing stable to key on: let it through rather than silently dropping
        // a genuine message. The durable unique index downstream is the backstop.
        if (!clientId || !eventId) {
          next();
          return;
        }

        const outcome = await store.claim(clientId, provider, eventId);
        if (!outcome.claimed) {
          req.log?.info({ clientId, provider, eventId, firstSeenAt: outcome.firstSeenAt }, "duplicate delivery dropped");
          res.status(200).json({ status: "duplicate", eventId });
          return;
        }

        next();
      } catch (err) {
        next(err);
      }
    })();
  };
}

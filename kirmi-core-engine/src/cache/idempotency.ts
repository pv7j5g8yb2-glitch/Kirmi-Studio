import type { Redis } from "ioredis";
import { REDIS_NAMESPACE } from "../config/constants.js";
import { env } from "../config/env.js";
import { redis } from "./redis.js";

/**
 * ===========================================================================
 * THE IDEMPOTENCY INTERCEPTOR
 * ===========================================================================
 *
 * Meta redelivers. Not occasionally: any time our acknowledgement is slow, gets
 * lost, or arrives after their timeout, the same message comes back with the
 * same id. Twilio does the same on status callbacks.
 *
 * Without a guard, one delayed acknowledgement becomes two quotes to the same
 * customer, or worse, two holds on the same car from the same person, one of
 * which silently blocks a real booking until it expires.
 *
 * The guard is a single atomic SET NX PX. First caller to claim a key wins and
 * processes; everyone else is told it is a duplicate and drops it. Atomic
 * matters: a GET followed by a SET has a window between them, and two workers
 * racing through that window both think they are first.
 *
 * Redis is the fast path, not the only path. The durable backstop is the unique
 * index on webhook_events (client_id, provider, external_event_id), which is
 * what still holds if Redis is flushed.
 */

export type ClaimOutcome =
  | { claimed: true }
  | { claimed: false; firstSeenAt: string };

function key(clientId: string, provider: string, eventId: string): string {
  return `${REDIS_NAMESPACE.idempotency}:${clientId}:${provider}:${eventId}`;
}

export interface IdempotencyStore {
  claim(clientId: string, provider: string, eventId: string, ttlSeconds?: number): Promise<ClaimOutcome>;
  release(clientId: string, provider: string, eventId: string): Promise<void>;
}

export function createIdempotencyStore(client: Redis = redis()): IdempotencyStore {
  return {
    /**
     * Claim an event id. True exactly once per id per TTL window, across every
     * process in the fleet.
     */
    async claim(clientId, provider, eventId, ttlSeconds): Promise<ClaimOutcome> {
      const k = key(clientId, provider, eventId);
      const ttl = ttlSeconds ?? env().IDEMPOTENCY_TTL_SECONDS;
      const stamp = new Date().toISOString();

      // NX makes this the atomic test-and-set the whole guard depends on.
      const result = await client.set(k, stamp, "EX", ttl, "NX");
      if (result === "OK") return { claimed: true };

      const firstSeenAt = (await client.get(k)) ?? "unknown";
      return { claimed: false, firstSeenAt };
    },

    /**
     * Give a claim back.
     *
     * Called when processing failed in a way the carrier should retry. Holding
     * the key after a failure would turn a transient error into a permanently
     * dropped message, which is the worse of the two failures: a duplicate
     * reply is embarrassing, a lost enquiry is lost revenue.
     */
    async release(clientId, provider, eventId): Promise<void> {
      await client.del(key(clientId, provider, eventId));
    },
  };
}

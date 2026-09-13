import type { Redis } from "ioredis";
import { REDIS_NAMESPACE } from "../config/constants.js";
import { logger } from "../core/logger.js";
import type { TenantProfile } from "../core/types.js";
import { redis } from "./redis.js";

/**
 * ===========================================================================
 * THE HOT CONTEXT CACHE
 * ===========================================================================
 *
 * The promise is a reply inside 15 seconds, and the target on the warm path is
 * under 3. Most of a reply's latency is not the model, it is everything the
 * model needs before it can be called: which tenant is this, what are their
 * rules, who is this customer, what did they already say.
 *
 * Fetching that from Postgres on every inbound message is four round trips
 * before a single token is generated. Cached, it is one Redis GET.
 *
 * Two rules keep this safe:
 *
 *   1. Every key is namespaced by clientId. A cache is a database, and a cache
 *      without tenant separation is a tenant isolation hole that row level
 *      security cannot see.
 *   2. Nothing here is authoritative. Prices, availability and booking state
 *      are always read from Postgres under a lock. This cache holds context for
 *      understanding a message, never facts used to commit to one.
 */

const CONTEXT_TTL_SECONDS = 1_800; // 30 minutes: roughly one live conversation.
const PROFILE_TTL_SECONDS = 300; // 5 minutes: config edits land within the hour.

export interface ConversationContext {
  conversationId: string;
  customerId: string;
  channel: string;
  state: string;
  aiEnabled: boolean;
  language: string | null;
  /** A short rolling window of turns. Enough to resolve "that one", not a transcript. */
  recentTurns: Array<{ role: "customer" | "agent"; text: string; at: string }>;
  /** Facts extracted so far, so the agent stops re-asking questions. */
  slots: {
    startAt?: string;
    endAt?: string;
    vehicleId?: string;
    categoryCode?: string;
    deliveryRequested?: boolean;
    driverAge?: number;
  };
  lastQuoteId?: string;
  updatedAt: string;
}

function contextKey(clientId: string, conversationId: string): string {
  return `${REDIS_NAMESPACE.conversationContext}:${clientId}:${conversationId}`;
}

function profileKey(clientId: string): string {
  return `${REDIS_NAMESPACE.tenantConfig}:${clientId}`;
}

export interface ContextCache {
  getContext(clientId: string, conversationId: string): Promise<ConversationContext | null>;
  putContext(clientId: string, context: ConversationContext): Promise<void>;
  dropContext(clientId: string, conversationId: string): Promise<void>;
  getProfile(clientId: string): Promise<TenantProfile | null>;
  putProfile(profile: TenantProfile): Promise<void>;
  dropProfile(clientId: string): Promise<void>;
}

/**
 * Every read is wrapped so a Redis failure degrades to a cache miss rather than
 * a failed reply. A slow answer beats no answer; an outage in a cache should
 * never be an outage in the product.
 */
async function safely<T>(operation: string, fn: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    logger().warn({ err, operation }, "context cache unavailable, falling through to source of truth");
    return fallback;
  }
}

export function createContextCache(client: Redis = redis()): ContextCache {
  return {
    async getContext(clientId, conversationId) {
      return safely(
        "getContext",
        async () => {
          const raw = await client.get(contextKey(clientId, conversationId));
          return raw ? (JSON.parse(raw) as ConversationContext) : null;
        },
        null,
      );
    },

    async putContext(clientId, context) {
      await safely(
        "putContext",
        async () => {
          await client.set(
            contextKey(clientId, context.conversationId),
            JSON.stringify({ ...context, updatedAt: new Date().toISOString() }),
            "EX",
            CONTEXT_TTL_SECONDS,
          );
        },
        undefined,
      );
    },

    async dropContext(clientId, conversationId) {
      await safely("dropContext", async () => void (await client.del(contextKey(clientId, conversationId))), undefined);
    },

    async getProfile(clientId) {
      return safely(
        "getProfile",
        async () => {
          const raw = await client.get(profileKey(clientId));
          return raw ? (JSON.parse(raw) as TenantProfile) : null;
        },
        null,
      );
    },

    async putProfile(profile) {
      await safely(
        "putProfile",
        async () => {
          await client.set(profileKey(profile.clientId), JSON.stringify(profile), "EX", PROFILE_TTL_SECONDS);
        },
        undefined,
      );
    },

    /** Called whenever a client's configuration changes, so edits land at once. */
    async dropProfile(clientId) {
      await safely("dropProfile", async () => void (await client.del(profileKey(clientId))), undefined);
    },
  };
}

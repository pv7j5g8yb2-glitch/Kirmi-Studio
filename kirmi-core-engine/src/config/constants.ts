/**
 * Values that are properties of the engine itself rather than of any client.
 * If a number in here would ever differ between two clients, it is in the wrong
 * file and belongs in client_configurations.
 */

/** Stamped onto every quote. Change it whenever pricing behaviour changes, so a
 *  historic quote can always be recomputed with the engine that produced it. */
export const PRICING_ENGINE_VERSION = "1.0.0";

/** Basis points are the unit for every rate in this engine: 10_000 = 1.0 = 100%.
 *  Percentages as floats produce 0.30000000000000004 in a VAT line. */
export const BASIS_POINTS_SCALE = 10_000;

/** Minor units per major unit. AED has 100 fils, and so does every currency this
 *  engine currently serves. A zero decimal currency would need this per client. */
export const MINOR_UNITS_PER_MAJOR = 100;

/** A rental day. Windows are measured in whole days, rounded up, minimum one. */
export const HOURS_PER_RENTAL_DAY = 24;

export const REDIS_NAMESPACE = {
  idempotency: "idem",
  conversationContext: "ctx",
  tenantConfig: "cfg",
  rateLimit: "rl",
  slaTimer: "sla",
} as const;

export const QUEUE_NAMES = {
  webhookIngest: "webhook-ingest",
  outboundDelivery: "outbound-delivery",
  metricsAttribution: "metrics-attribution",
  holdSweeper: "hold-sweeper",
  followUpSweeper: "follow-up-sweeper",
} as const;

export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];

/** The transaction local Postgres setting every tenant scoped query runs under. */
export const TENANT_GUC = "app.current_client_id";

/** Postgres SQLSTATE for "could not obtain lock, NOWAIT was specified". This is
 *  the code that tells us a concurrent request already claimed the vehicle. */
export const PG_LOCK_NOT_AVAILABLE = "55P03";
/** SQLSTATE for an exclusion constraint violation: the overlap backstop fired. */
export const PG_EXCLUSION_VIOLATION = "23P01";
/** SQLSTATE for unique violation. */
export const PG_UNIQUE_VIOLATION = "23505";

/** How many characters of an API key are stored in clear as a lookup prefix. */
export const API_KEY_PREFIX_LENGTH = 12;

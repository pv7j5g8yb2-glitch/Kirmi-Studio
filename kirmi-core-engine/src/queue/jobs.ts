import { QUEUE_NAMES } from "../config/constants.js";

/**
 * Job contracts.
 *
 * Every payload carries clientId as its first field, and that is not a
 * convention, it is the isolation boundary. A worker runs outside the HTTP
 * request that created the job, so AsyncLocalStorage is empty by the time it
 * starts. It must open its own tenant scope from this payload before it
 * touches the database, or row level security will hand it an empty result set
 * and the job will look like it succeeded while doing nothing.
 *
 * Payloads are also deliberately thin: ids, not objects. A job that carries a
 * snapshot of a row acts on stale data by the time it runs.
 */

export interface WebhookIngestJob {
  clientId: string;
  provider: "meta" | "twilio";
  /** Row already written by the route, so the payload survives a Redis loss. */
  webhookEventId: string;
  /** Wall clock receipt time, so a job that waited in the queue still reports
   *  true end to end latency against the SLA rather than its own runtime. */
  receivedAtIso: string;
}

export interface OutboundDeliveryJob {
  clientId: string;
  conversationId: string;
  messageId: string;
  channel: "WHATSAPP" | "INSTAGRAM" | "TELEPHONY" | "WEB";
  to: string;
  body: string;
}

export interface MetricsAttributionJob {
  clientId: string;
  auditLogId: string;
}

export interface HoldSweeperJob {
  /** Absent means every active client: the sweeper is platform wide. */
  clientId?: string;
}

export interface JobPayloads {
  [QUEUE_NAMES.webhookIngest]: WebhookIngestJob;
  [QUEUE_NAMES.outboundDelivery]: OutboundDeliveryJob;
  [QUEUE_NAMES.metricsAttribution]: MetricsAttributionJob;
  [QUEUE_NAMES.holdSweeper]: HoldSweeperJob;
}

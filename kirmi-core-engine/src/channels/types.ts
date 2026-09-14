import type { ChannelType } from "@prisma/client";

/**
 * The outbound side of a channel.
 *
 * Deliberately narrow. Everything the engine needs to say to a customer fits
 * through send(), which means adding a channel is adding one file and testing
 * the pipeline needs no network.
 *
 * `body` is always populated, on every kind of message including a template.
 * That is not redundancy: the transcript, the human inbox and the attribution
 * report all read `body`, and a row that says only "sent template
 * quote_follow_up" is useless to the person trying to work out what the
 * customer was actually told.
 */

/** A photograph or a document. Meta fetches the URL itself, so it must be
 *  publicly reachable and served over TLS. */
export interface OutboundMedia {
  url: string;
  kind: "image" | "document";
  /** Only the first attachment carries the caption; Meta ignores the rest. */
  caption?: string;
  /** Documents are shown under this name in the customer's chat. */
  filename?: string;
}

/**
 * An approved WhatsApp template.
 *
 * Outside the 24 hour customer service window Meta permits nothing else, so
 * this is the only way the engine may open a conversation: every follow up,
 * every missed call recovery, every reactivation.
 */
export interface OutboundTemplate {
  name: string;
  language: string;
  /** Positional {{1}}, {{2}} ... substitutions, in order. */
  bodyParams: string[];
}

export interface OutboundMessage {
  /** E.164 phone for WhatsApp and SMS, Instagram Scoped ID for IG. */
  to: string;
  /** The text as the customer will read it, and as the transcript records it. */
  body: string;
  /** Correlates our record with the carrier's, for delivery receipts. */
  correlationId: string;
  media?: OutboundMedia[];
  /** Present when the service window has closed and only a template may go out. */
  template?: OutboundTemplate;
}

export interface DeliveryResult {
  providerMessageId: string | null;
  accepted: boolean;
  /** Set when the carrier refused. Retryable failures throw instead. */
  rejection?: string;
  /** Meta's numeric error code, kept because the fallback decision turns on it:
   *  131026 and 131047 mean this number cannot receive WhatsApp at all, which
   *  is an SMS case rather than a failure. */
  rejectionCode?: number;
}

export interface ChannelProvider {
  readonly channel: ChannelType;
  send(tenantId: string, message: OutboundMessage): Promise<DeliveryResult>;
}

/**
 * A carrier failure that is worth retrying: a timeout, a 5xx, a rate limit.
 * Distinguished from a refusal, because retrying a refusal just annoys the
 * carrier and delays the moment a human finds out.
 */
export class TransientDeliveryError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "TransientDeliveryError";
  }
}

/**
 * Meta error codes that mean "this number is not on WhatsApp", as opposed to
 * "this message was wrong".
 *
 * The difference decides whether a missed call turns into a recovered booking
 * or into silence: the first case is exactly what the SMS fallback exists for,
 * and retrying it on WhatsApp would never succeed.
 *
 *   131026  message undeliverable, recipient not a valid WhatsApp user
 *   131047  re-engagement outside the window, no template used
 *   131051  unsupported message type for this recipient
 */
export const WHATSAPP_UNREACHABLE_CODES = new Set([131_026, 131_047, 131_051]);

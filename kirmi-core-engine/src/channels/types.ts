import type { ChannelType } from "@prisma/client";

/**
 * The outbound side of a channel.
 *
 * Narrow on purpose. Everything the engine needs to say to a customer fits
 * through send(), which means adding a channel is adding one file, and testing
 * the pipeline needs no network.
 */
export interface OutboundMessage {
  /** E.164 phone for WhatsApp, Instagram Scoped ID for IG. */
  to: string;
  body: string;
  /** Correlates our record with the carrier's, for delivery receipts. */
  correlationId: string;
}

export interface DeliveryResult {
  providerMessageId: string | null;
  accepted: boolean;
  /** Set when the carrier refused. Retryable failures throw instead. */
  rejection?: string;
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

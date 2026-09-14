import type { Minor } from "../core/money.js";

/**
 * ===========================================================================
 * PAYMENT LINKS
 * ===========================================================================
 *
 * A hold is a lock on a car. A booking is money. This is the boundary between
 * the two, and it is deliberately the narrowest interface in the engine.
 *
 * The model never sees any of this. It cannot compose a URL, cannot name an
 * amount and cannot mark anything paid: a hallucinated payment link sent to a
 * customer in writing is the single worst thing this system could do, so the
 * only way a link reaches a customer is this interface returning one.
 */

export interface PaymentLinkRequest {
  clientId: string;
  reservationId: string;
  /** Shown to the customer, so they recognise what they are paying for. */
  description: string;
  amountMinor: Minor;
  currency: string;
  /** The booking reference, used as the provider's idempotency key so a retry
   *  cannot create a second link for the same reservation. */
  reference: string;
  customerName: string | null;
}

export interface PaymentLink {
  /** Null for the manual provider: there is no page to send them to. */
  url: string | null;
  provider: string;
  /** The provider's own id, kept so a webhook can be matched back later. */
  providerReference: string | null;
  /** What to say to the customer. Manual settlement needs real instructions
   *  rather than a link, and the wording differs enough to belong here. */
  instructions: string;
}

export interface PaymentProvider {
  readonly name: string;
  createLink(request: PaymentLinkRequest): Promise<PaymentLink>;
}

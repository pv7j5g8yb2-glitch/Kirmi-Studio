import { formatMoney } from "../core/money.js";
import type { PaymentLink, PaymentLinkRequest, PaymentProvider } from "./types.js";

/**
 * Settlement at the desk, by transfer, or by card on collection.
 *
 * This is not a placeholder. It is the correct configuration for a client who
 * has not connected a gateway, and it is what lets a pilot go live without
 * waiting on somebody's finance department to produce API keys. The booking
 * still happens, the car is still held, the customer still gets a clear
 * instruction; only the tap to pay is missing.
 *
 * Wiring a real gateway later changes one config row and nothing else.
 */
export class ManualPaymentProvider implements PaymentProvider {
  readonly name = "manual";

  constructor(private readonly businessName: string) {}

  async createLink(request: PaymentLinkRequest): Promise<PaymentLink> {
    const amount = formatMoney(request.amountMinor, request.currency);
    return {
      url: null,
      provider: this.name,
      providerReference: request.reference,
      instructions:
        `Your reference is ${request.reference} and the total is ${amount}. ` +
        `${this.businessName} will take payment when you collect, and the car is held for you until then.`,
    };
  }
}

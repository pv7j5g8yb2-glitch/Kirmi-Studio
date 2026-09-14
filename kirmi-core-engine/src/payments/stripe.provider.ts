import { ConfigurationError } from "../core/errors.js";
import type { Logger } from "../core/logger.js";
import { formatMoney } from "../core/money.js";
import type { PaymentLink, PaymentLinkRequest, PaymentProvider } from "./types.js";

/**
 * Stripe Checkout, via the REST API rather than the SDK.
 *
 * The SDK is a dependency, a version to keep current and a surface to audit,
 * for two endpoints. Same reasoning as the Meta and Anthropic clients: a
 * narrow fetch call is easier to read, easier to stub in tests and does not
 * drag a package's entire release cadence into this repository.
 *
 * Amounts arrive already in minor units because that is how the pricing engine
 * works throughout, and Stripe wants minor units too. No conversion, no
 * rounding, no float ever touches a price on the way out.
 */
export class StripePaymentProvider implements PaymentProvider {
  readonly name = "stripe";

  constructor(
    private readonly secretKey: string | null,
    private readonly successUrl: string,
    private readonly log: Logger,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async createLink(request: PaymentLinkRequest): Promise<PaymentLink> {
    if (!this.secretKey) {
      throw new ConfigurationError("No Stripe secret key configured for this client", {
        clientId: request.clientId,
      });
    }

    const form = new URLSearchParams({
      mode: "payment",
      success_url: this.successUrl,
      "line_items[0][quantity]": "1",
      "line_items[0][price_data][currency]": request.currency.toLowerCase(),
      "line_items[0][price_data][unit_amount]": String(request.amountMinor),
      "line_items[0][price_data][product_data][name]": request.description,
      client_reference_id: request.reference,
      "metadata[reservationId]": request.reservationId,
      "metadata[clientId]": request.clientId,
    });

    const response = await this.fetchImpl("https://api.stripe.com/v1/checkout/sessions", {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.secretKey}`,
        "content-type": "application/x-www-form-urlencoded",
        // Keyed on the booking reference, so a retried job returns the session
        // that already exists instead of charging the customer twice.
        "idempotency-key": `res_${request.reservationId}`,
      },
      body: form.toString(),
      signal: AbortSignal.timeout(8_000),
    });

    const body = (await response.json().catch(() => ({}))) as {
      id?: string;
      url?: string;
      error?: { message?: string };
    };

    if (!response.ok || !body.url) {
      this.log.error(
        { clientId: request.clientId, status: response.status, stripeError: body.error?.message },
        "stripe refused to create a checkout session",
      );
      throw new ConfigurationError(body.error?.message ?? `Stripe responded ${response.status}`, {
        clientId: request.clientId,
      });
    }

    return {
      url: body.url,
      provider: this.name,
      providerReference: body.id ?? null,
      instructions:
        `That is ${formatMoney(request.amountMinor, request.currency)} for reference ${request.reference}. ` +
        `The car stays held until the payment goes through.`,
    };
  }
}

import { env } from "../config/env.js";
import type { Logger } from "../core/logger.js";
import type { TenantProfile, TenantSecrets } from "../core/types.js";
import { ManualPaymentProvider } from "./manual.provider.js";
import { StripePaymentProvider } from "./stripe.provider.js";
import type { PaymentProvider } from "./types.js";

/**
 * Which provider a client pays through.
 *
 * Falls back to manual rather than throwing. A missing gateway key should
 * degrade a booking to "pay at the desk", which still converts, rather than
 * failing the customer at the last step of a conversation that went well.
 */
export function providerFor(
  profile: TenantProfile,
  secrets: Pick<TenantSecrets, "paymentSecretKey">,
  paymentAccessKeys: { provider?: string } | null,
  log: Logger,
): PaymentProvider {
  const configured = paymentAccessKeys?.provider ?? "manual";

  if (configured === "stripe" && secrets.paymentSecretKey) {
    return new StripePaymentProvider(
      secrets.paymentSecretKey,
      `${env().PUBLIC_BASE_URL}/paid`,
      log,
    );
  }

  if (configured !== "manual") {
    log.warn(
      { clientId: profile.clientId, configured },
      "payment provider is configured but unusable, falling back to settlement at the desk",
    );
  }

  return new ManualPaymentProvider(profile.tradingName);
}

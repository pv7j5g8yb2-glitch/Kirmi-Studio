import type { ChannelType } from "@prisma/client";
import type { Logger } from "../core/logger.js";
import { ConfigurationError } from "../core/errors.js";
import type { ClientConfigService } from "../services/client-config.service.js";
import { TransientDeliveryError, type ChannelProvider, type DeliveryResult, type OutboundMessage } from "./types.js";

/**
 * ===========================================================================
 * SENDING THROUGH THE META GRAPH API
 * ===========================================================================
 *
 * WhatsApp Business and Instagram DM both go out through the Graph API, with
 * different endpoints and payload shapes, so one class covers both rather than
 * duplicating the credential handling and error mapping twice.
 *
 * The access token is per tenant, fetched fresh and never cached: it is the
 * most damaging single credential in the configuration row, because it can post
 * as the client's business.
 *
 * Failures are classified rather than lumped together. A 429 or a 5xx is worth
 * retrying and the queue will; a 400 means the message itself is wrong and
 * retrying it four more times only delays the moment a human finds out.
 */
export class MetaChannelProvider implements ChannelProvider {
  constructor(
    readonly channel: ChannelType,
    private readonly config: ClientConfigService,
    private readonly log: Logger,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async send(tenantId: string, message: OutboundMessage): Promise<DeliveryResult> {
    const profile = await this.config.loadProfile(tenantId);
    const secrets = await this.config.loadSecrets(tenantId);

    if (!secrets.metaAccessToken) {
      throw new ConfigurationError("No Meta access token configured for this client", { clientId: tenantId });
    }

    const senderId =
      this.channel === "WHATSAPP" ? profile.channels.metaPhoneNumberId : profile.channels.instagramScopedPageId;
    if (!senderId) {
      throw new ConfigurationError(`No Meta sender id configured for ${this.channel}`, { clientId: tenantId });
    }

    const version = secrets.metaGraphApiVersion ?? "v21.0";
    const url = `https://graph.facebook.com/${version}/${senderId}/messages`;

    const payload =
      this.channel === "WHATSAPP"
        ? { messaging_product: "whatsapp", recipient_type: "individual", to: message.to, type: "text", text: { preview_url: false, body: message.body } }
        : { recipient: { id: message.to }, message: { text: message.body } };

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${secrets.metaAccessToken}` },
        body: JSON.stringify(payload),
        // A send that outlives the reply budget has already failed the customer.
        signal: AbortSignal.timeout(8_000),
      });
    } catch (err) {
      // Network level: always worth another attempt.
      throw new TransientDeliveryError(err instanceof Error ? err.message : "network failure");
    }

    if (response.status === 429 || response.status >= 500) {
      throw new TransientDeliveryError(`Meta responded ${response.status}`, response.status);
    }

    const body = (await response.json().catch(() => ({}))) as {
      messages?: Array<{ id?: string }>;
      message_id?: string;
      error?: { message?: string; code?: number };
    };

    if (!response.ok) {
      // A refusal, not a failure. Recorded and surfaced rather than retried.
      this.log.error(
        { clientId: tenantId, status: response.status, metaError: body.error?.message, metaCode: body.error?.code },
        "meta refused the message",
      );
      return { providerMessageId: null, accepted: false, rejection: body.error?.message ?? `HTTP ${response.status}` };
    }

    return {
      providerMessageId: body.messages?.[0]?.id ?? body.message_id ?? null,
      accepted: true,
    };
  }
}

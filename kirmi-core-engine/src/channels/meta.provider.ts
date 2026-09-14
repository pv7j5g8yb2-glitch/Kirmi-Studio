import type { ChannelType } from "@prisma/client";
import type { Logger } from "../core/logger.js";
import { ConfigurationError } from "../core/errors.js";
import type { ClientConfigService } from "../services/client-config.service.js";
import {
  TransientDeliveryError,
  type ChannelProvider,
  type DeliveryResult,
  type OutboundMedia,
  type OutboundMessage,
} from "./types.js";

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

    const payload = this.buildPayload(message);

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
      return {
        providerMessageId: null,
        accepted: false,
        rejection: body.error?.message ?? `HTTP ${response.status}`,
        ...(typeof body.error?.code === "number" ? { rejectionCode: body.error.code } : {}),
      };
    }

    return {
      providerMessageId: body.messages?.[0]?.id ?? body.message_id ?? null,
      accepted: true,
    };
  }

  /**
   * One message becomes one Graph payload.
   *
   * The order of the checks is the business rule: a template wins over
   * everything, because if the service window has shut a template is the only
   * thing Meta will accept and sending anything else is a guaranteed refusal.
   * Media comes next, and plain text is the fallback.
   */
  private buildPayload(message: OutboundMessage): Record<string, unknown> {
    if (this.channel === "INSTAGRAM") {
      // Instagram has no template concept on this endpoint, and its attachment
      // payload is shaped differently. An image goes as its own message with
      // the text following, which is also how it reads best in the app.
      const image = message.media?.find((m) => m.kind === "image");
      return image
        ? {
            recipient: { id: message.to },
            message: { attachment: { type: "image", payload: { url: image.url, is_reusable: true } } },
          }
        : { recipient: { id: message.to }, message: { text: message.body } };
    }

    const envelope = { messaging_product: "whatsapp", recipient_type: "individual", to: message.to };

    if (message.template) {
      return {
        ...envelope,
        type: "template",
        template: {
          name: message.template.name,
          language: { code: message.template.language },
          // An empty components array is rejected, so a template with no
          // placeholders must omit the key entirely rather than send [].
          ...(message.template.bodyParams.length > 0
            ? {
                components: [
                  {
                    type: "body",
                    parameters: message.template.bodyParams.map((text) => ({ type: "text", text })),
                  },
                ],
              }
            : {}),
        },
      };
    }

    const attachment = message.media?.[0];
    if (attachment) return { ...envelope, ...metaMediaBody(attachment) };

    return { ...envelope, type: "text", text: { preview_url: false, body: message.body } };
  }
}

/**
 * WhatsApp takes one attachment per message, so a fleet of photographs is a
 * sequence of sends rather than one call. The caption rides on the first, which
 * is why the dispatcher orders them and only captions the head of the list.
 */
function metaMediaBody(media: OutboundMedia): Record<string, unknown> {
  if (media.kind === "document") {
    return {
      type: "document",
      document: {
        link: media.url,
        ...(media.filename ? { filename: media.filename } : {}),
        ...(media.caption ? { caption: media.caption } : {}),
      },
    };
  }
  return {
    type: "image",
    image: { link: media.url, ...(media.caption ? { caption: media.caption } : {}) },
  };
}

import type { ChannelType } from "@prisma/client";
import { ConfigurationError } from "../core/errors.js";
import type { Logger } from "../core/logger.js";
import type { ClientConfigService } from "../services/client-config.service.js";
import { TransientDeliveryError, type ChannelProvider, type DeliveryResult, type OutboundMessage } from "./types.js";

/**
 * ===========================================================================
 * SMS, THE LAST RESORT
 * ===========================================================================
 *
 * Outbound only, and deliberately unglamorous. This exists for one situation:
 * somebody rang the client's number, nobody picked up, and that number turns
 * out not to be on WhatsApp. Without this the enquiry is simply gone, and a
 * missed call at a luxury rental desk is a four figure loss.
 *
 * Two design notes worth keeping in mind before extending it.
 *
 * SMS has no threads, no read receipts and no templates. Every message is a
 * cold open to somebody who may not recognise the number, so the body has to
 * name the business in the first few words. That is the caller's job, not this
 * class's, but it is why the dispatcher composes SMS text separately rather
 * than reusing the WhatsApp wording.
 *
 * It also costs real money per segment and is billed by the carrier, so it is
 * off by default per client and every send is recorded like any other message.
 */
export class TwilioSmsProvider implements ChannelProvider {
  readonly channel: ChannelType = "SMS";

  constructor(
    private readonly config: ClientConfigService,
    private readonly log: Logger,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async send(tenantId: string, message: OutboundMessage): Promise<DeliveryResult> {
    const profile = await this.config.loadProfile(tenantId);
    const secrets = await this.config.loadSecrets(tenantId);

    if (!secrets.twilioAuthToken || !profile.channels.twilioAccountSid) {
      throw new ConfigurationError("No Twilio credentials configured for this client", { clientId: tenantId });
    }
    if (!profile.channels.twilioNumber) {
      throw new ConfigurationError("No Twilio sending number configured for this client", { clientId: tenantId });
    }

    const accountSid = profile.channels.twilioAccountSid;
    const url = `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`;

    // Twilio's REST API is form encoded, not JSON. Posting JSON to it returns a
    // 400 that reads like a validation error on the body rather than on the
    // content type, which is a genuinely confusing hour to lose.
    const form = new URLSearchParams({
      To: message.to,
      From: profile.channels.twilioNumber,
      Body: message.body,
    });

    // MMS costs several times an SMS and is not supported by every carrier in
    // the region, so photographs stay on WhatsApp. An SMS mentions them instead.
    if (message.media?.length) {
      this.log.debug({ clientId: tenantId, count: message.media.length }, "dropping media from an SMS send");
    }

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          authorization: `Basic ${Buffer.from(`${accountSid}:${secrets.twilioAuthToken}`).toString("base64")}`,
        },
        body: form.toString(),
        signal: AbortSignal.timeout(8_000),
      });
    } catch (err) {
      throw new TransientDeliveryError(err instanceof Error ? err.message : "network failure");
    }

    if (response.status === 429 || response.status >= 500) {
      throw new TransientDeliveryError(`Twilio responded ${response.status}`, response.status);
    }

    const body = (await response.json().catch(() => ({}))) as {
      sid?: string;
      status?: string;
      message?: string;
      code?: number;
    };

    if (!response.ok) {
      this.log.error(
        { clientId: tenantId, status: response.status, twilioError: body.message, twilioCode: body.code },
        "twilio refused the message",
      );
      return {
        providerMessageId: null,
        accepted: false,
        rejection: body.message ?? `HTTP ${response.status}`,
        ...(typeof body.code === "number" ? { rejectionCode: body.code } : {}),
      };
    }

    return { providerMessageId: body.sid ?? null, accepted: true };
  }
}

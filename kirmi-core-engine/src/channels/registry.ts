import type { ChannelType } from "@prisma/client";
import type { Logger } from "../core/logger.js";
import type { ClientConfigService } from "../services/client-config.service.js";
import { MetaChannelProvider } from "./meta.provider.js";
import { TwilioSmsProvider } from "./twilio.provider.js";
import type { ChannelProvider } from "./types.js";

/**
 * Channel lookup.
 *
 * Adding a channel is registering a provider here. Nothing else in the engine
 * names a channel: the pipeline asks the registry for whatever channel the
 * conversation is on and sends.
 */
export class ChannelRegistry {
  private readonly providers = new Map<ChannelType, ChannelProvider>();

  constructor(config: ClientConfigService, log: Logger) {
    this.register(new MetaChannelProvider("WHATSAPP", config, log));
    this.register(new MetaChannelProvider("INSTAGRAM", config, log));
    // Outbound only. Nothing routes a conversation here; the delivery worker
    // reaches for it when WhatsApp reports the number cannot receive.
    this.register(new TwilioSmsProvider(config, log));
    // TELEPHONY is inbound only: a missed call becomes a WhatsApp message
    // rather than an automated call back, because nobody wants a robot ringing
    // them back, and WEB is served by the dashboard rather than a carrier.
  }

  register(provider: ChannelProvider): void {
    this.providers.set(provider.channel, provider);
  }

  get(channel: ChannelType): ChannelProvider | null {
    return this.providers.get(channel) ?? null;
  }
}

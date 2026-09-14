import type { Client, ClientConfiguration, TenantDirectory } from "@prisma/client";
import {
  addOnCatalogueSchema,
  categoryAgeOverridesSchema,
  escalationRulesSchema,
  escalationTargetsSchema,
  followUpPolicySchema,
  messageTemplatesSchema,
  openingHoursSchema,
  seasonalModifiersSchema,
} from "../config/tenant-schema.js";
import type { ContextCache } from "../cache/conversation-context.cache.js";
import { decryptSecret } from "../core/crypto.js";
import { ConfigurationError, TenantResolutionError } from "../core/errors.js";
import type { Logger } from "../core/logger.js";
import type { TenantProfile, TenantSecrets } from "../core/types.js";
import type { TenantDatabase } from "../db/tenant-context.js";

/**
 * ===========================================================================
 * THE CLIENT CONFIGURATION LAYER
 * ===========================================================================
 *
 * This service is the seam between the stateless core and the per client
 * settings that make the same code behave differently for DEIZ Rental Dubai
 * than for the next client onboarded. Everything downstream takes a
 * TenantProfile and never asks which client it is serving.
 *
 * Resolution happens in two stages, and the order is forced by tenant
 * isolation. An inbound webhook names a slug or a WhatsApp phone number id,
 * not a clientId, so stage one reads the routing projection with no tenant in
 * scope. Only once a clientId is known can stage two open a tenant scoped
 * transaction and load the configuration itself.
 */

export type RoutingKey =
  | { kind: "slug"; value: string }
  | { kind: "metaPhoneNumberId"; value: string }
  | { kind: "instagramPageId"; value: string }
  | { kind: "twilioNumber"; value: string };

export interface TenantRouting {
  clientId: string;
  slug: string;
  tradingName: string;
  timezone: string;
  status: Client["status"];
}

export class ClientConfigService {
  constructor(
    private readonly db: TenantDatabase,
    private readonly cache: ContextCache,
    private readonly log: Logger,
  ) {}

  /**
   * Stage one. Turn whatever the carrier told us into a clientId.
   *
   * Reads tenant_directory, the one table outside row level security, because
   * this call necessarily happens before any tenant is in scope. The table
   * holds routing identifiers only, so this query cannot expose anything a
   * caller did not already have.
   */
  async resolveRouting(key: RoutingKey): Promise<TenantRouting> {
    const where: Record<string, string> =
      key.kind === "slug"
        ? { slug: key.value }
        : key.kind === "metaPhoneNumberId"
          ? { metaPhoneNumberId: key.value }
          : key.kind === "instagramPageId"
            ? { instagramScopedPageId: key.value }
            : { twilioNumber: key.value };

    const row: TenantDirectory | null = await this.db.raw().tenantDirectory.findFirst({ where });

    if (!row) {
      // Deliberately vague to the caller. Which routing keys exist is not
      // information an unauthenticated request should be able to probe for.
      this.log.warn({ routingKind: key.kind }, "no tenant matches routing key");
      throw new TenantResolutionError("No tenant matches this routing key", { routingKind: key.kind });
    }

    if (row.status === "SUSPENDED" || row.status === "CHURNED") {
      throw new TenantResolutionError("Tenant is not active", { clientId: row.clientId, status: row.status });
    }

    return {
      clientId: row.clientId,
      slug: row.slug,
      tradingName: row.tradingName,
      timezone: row.timezone,
      status: row.status,
    };
  }

  /**
   * Every active tenant, for the platform wide background jobs (the hold
   * sweeper, monthly retainer attribution). Those jobs legitimately span
   * tenants, and they get the list from here so that they still do their actual
   * work one tenant scope at a time rather than in one unscoped query.
   */
  async listActiveClientIds(): Promise<string[]> {
    const rows = await this.db.raw().tenantDirectory.findMany({
      where: { status: "ACTIVE" },
      select: { clientId: true },
    });
    return rows.map((r) => r.clientId);
  }

  /**
   * Stage two. The full profile, cached hot.
   *
   * Cache first because this sits inside the latency budget of every inbound
   * message. A cache miss costs one query; a cache that is never consulted
   * costs one query per message forever.
   */
  async loadProfile(clientId: string): Promise<TenantProfile> {
    const cached = await this.cache.getProfile(clientId);
    if (cached) return cached;

    const profile = await this.db.withTenant(clientId, async (tx) => {
      const client = await tx.client.findUnique({
        where: { id: clientId },
        include: { configuration: true },
      });
      if (!client) {
        // Row level security is doing its job if we get here with a real id but
        // the wrong scope, so this is both "no such client" and "not yours".
        throw new TenantResolutionError("Client not visible in this tenant scope", { clientId });
      }
      if (!client.configuration) {
        throw new ConfigurationError("Client has no configuration row, onboarding is incomplete", { clientId });
      }
      return this.toProfile(client, client.configuration);
    });

    await this.cache.putProfile(profile);
    return profile;
  }

  /** Called after any configuration write so an edit takes effect immediately. */
  async invalidate(clientId: string): Promise<void> {
    await this.cache.dropProfile(clientId);
  }

  /**
   * Credentials, decrypted, fetched only on the path that needs them.
   *
   * Never cached and never part of TenantProfile. The profile is passed
   * around, logged and serialised into Redis; if a secret lived on it, it would
   * end up in all three places.
   */
  async loadSecrets(clientId: string): Promise<TenantSecrets> {
    return this.db.withTenant(clientId, async (tx) => {
      const config = await tx.clientConfiguration.findUnique({ where: { clientId } });
      if (!config) throw new ConfigurationError("Client has no configuration row", { clientId });

      const paymentKeys = config.paymentAccessKeys as { secretKeyEncrypted?: string } | null;

      return {
        metaAppSecret: this.decryptOrNull(config.metaAppSecretEncrypted, clientId, "metaAppSecret"),
        metaVerifyToken: config.metaVerifyToken,
        metaAccessToken: this.decryptOrNull(config.metaAccessTokenEncrypted, clientId, "metaAccessToken"),
        metaGraphApiVersion: config.metaGraphApiVersion,
        twilioAuthToken: this.decryptOrNull(config.twilioAuthTokenEncrypted, clientId, "twilioAuthToken"),
        paymentSecretKey: this.decryptOrNull(paymentKeys?.secretKeyEncrypted ?? null, clientId, "paymentSecretKey"),
      };
    });
  }

  /**
   * The Stripe endpoint signing secret for this client, decrypted.
   *
   * Its own method rather than part of loadSecrets, because it is read on an
   * unauthenticated public route before anything is trusted, and a narrow
   * accessor keeps every other credential out of that code path.
   */
  async loadPaymentWebhookSecret(clientId: string): Promise<string | null> {
    return this.db.withTenant(clientId, async (tx) => {
      const config = await tx.clientConfiguration.findUnique({
        where: { clientId },
        select: { paymentAccessKeys: true },
      });
      const keys = config?.paymentAccessKeys as { webhookSecretEncrypted?: string } | null;
      return this.decryptOrNull(keys?.webhookSecretEncrypted ?? null, clientId, "paymentWebhookSecret");
    });
  }

  /**
   * The non secret half of the payment configuration: which provider, and how
   * much to capture up front. The secret half comes back from loadSecrets, and
   * the two stay apart so the provider choice can be read and logged freely.
   */
  async loadPaymentAccessKeys(clientId: string): Promise<{ provider?: string } | null> {
    return this.db.withTenant(clientId, async (tx) => {
      const config = await tx.clientConfiguration.findUnique({
        where: { clientId },
        select: { paymentAccessKeys: true },
      });
      return (config?.paymentAccessKeys as { provider?: string } | null) ?? null;
    });
  }

  /**
   * A failed decryption is a configuration problem, not a reason to crash a
   * webhook. Returning null lets the caller fall back to the platform secret or
   * reject the request cleanly, with the failure logged under the client's id.
   */
  private decryptOrNull(value: string | null | undefined, clientId: string, field: string): string | null {
    if (!value) return null;
    try {
      return decryptSecret(value);
    } catch (err) {
      this.log.error({ err, clientId, field }, "stored credential could not be decrypted");
      return null;
    }
  }

  /**
   * Database row to validated profile.
   *
   * Every JSON column is parsed through its zod schema here, once, at the
   * boundary. A malformed config then fails with the client's id and the
   * offending field attached, instead of surfacing as an undefined three
   * frames into a price calculation.
   */
  private toProfile(client: Client, config: ClientConfiguration): TenantProfile {
    const parse = <T>(schema: { safeParse: (v: unknown) => { success: boolean; data?: T; error?: unknown } }, value: unknown, field: string): T => {
      const result = schema.safeParse(value);
      if (!result.success || result.data === undefined) {
        throw new ConfigurationError(`Client configuration field is invalid: ${field}`, {
          clientId: client.id,
          field,
          issue: String(result.error),
        });
      }
      return result.data;
    };

    return {
      clientId: client.id,
      slug: client.slug,
      legalName: client.legalName,
      tradingName: client.tradingName,
      currency: client.currency,
      timezone: client.timezone,
      status: client.status,

      languages: {
        supported: config.supportedLanguages,
        default: config.defaultLanguage,
      },

      qualification: {
        minimumDriverAge: config.minimumDriverAge,
        minimumLicenceYears: config.minimumLicenceYears,
        requiredDocuments: config.requiredDocuments,
        categoryAgeOverrides: parse(categoryAgeOverridesSchema, config.categoryAgeOverrides, "categoryAgeOverrides"),
      },

      pricing: {
        vatBasisPoints: config.vatBasisPoints,
        weeklyThresholdDays: config.weeklyThresholdDays,
        monthlyThresholdDays: config.monthlyThresholdDays,
        deliveryFeeMinor: config.deliveryFeeMinor,
        freeDeliveryThresholdDays: config.freeDeliveryThresholdDays,
        defaultDepositMinor: config.defaultDepositMinor,
        seasonalModifiers: parse(seasonalModifiersSchema, config.seasonalModifiers, "seasonalModifiers"),
        addOnCatalogue: parse(addOnCatalogueSchema, config.addOnCatalogue, "addOnCatalogue"),
        quoteValidMinutes: config.quoteValidMinutes,
        holdTtlMinutes: config.holdTtlMinutes,
        paymentHoldMinutes: config.paymentHoldMinutes,
      },

      openingHours: parse(openingHoursSchema, config.openingHours, "openingHours"),

      escalation: {
        targets: parse(escalationTargetsSchema, config.escalationTargets, "escalationTargets"),
        rules: parse(escalationRulesSchema, config.escalationRules, "escalationRules"),
      },

      billing: {
        feeModel: config.feeModel,
        retainerMinor: config.retainerMinor,
        commissionBasisPoints: config.commissionBasisPoints,
      },

      agent: {
        displayName: config.agentDisplayName,
        toneNotes: config.agentToneNotes,
        systemPromptExtra: config.systemPromptExtra,
      },

      proactive: {
        templates: parse(messageTemplatesSchema, config.messageTemplates, "messageTemplates"),
        followUp: parse(followUpPolicySchema, config.followUpPolicy, "followUpPolicy"),
        smsFallbackEnabled: config.smsFallbackEnabled,
        vehiclePhotosEnabled: config.vehiclePhotosEnabled,
      },

      channels: {
        metaPhoneNumberId: config.metaPhoneNumberId,
        metaBusinessAccountId: config.metaBusinessAccountId,
        instagramScopedPageId: config.instagramScopedPageId,
        twilioAccountSid: config.twilioAccountSid,
        twilioNumber: config.twilioNumber,
      },
    };
  }
}

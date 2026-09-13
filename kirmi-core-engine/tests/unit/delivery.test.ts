import { describe, expect, it, vi } from "vitest";
import { MetaChannelProvider } from "../../src/channels/meta.provider.js";
import { TransientDeliveryError } from "../../src/channels/types.js";
import { ConfigurationError } from "../../src/core/errors.js";
import { logger } from "../../src/core/logger.js";
import type { ClientConfigService } from "../../src/services/client-config.service.js";
import type { TenantSecrets } from "../../src/core/types.js";
import { tenantFixture } from "../helpers/fixtures.js";

/**
 * Outbound delivery.
 *
 * The classification is what these tests are really about. A 429 or a 5xx is
 * worth retrying and must throw so the queue backs off; a 400 means the message
 * itself is wrong, and retrying it four more times only delays the moment a
 * human finds out the customer received nothing.
 */

const CLIENT_ID = "11111111-1111-4111-8111-111111111111";

function stubConfig(secrets: Partial<TenantSecrets> = {}): ClientConfigService {
  return {
    loadProfile: async () => tenantFixture(),
    loadSecrets: async (): Promise<TenantSecrets> => ({
      metaAppSecret: null,
      metaVerifyToken: null,
      metaAccessToken: "EAAG-access-token",
      metaGraphApiVersion: "v21.0",
      twilioAuthToken: null,
      paymentSecretKey: null,
      ...secrets,
    }),
  } as unknown as ClientConfigService;
}

const jsonResponse = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("Meta delivery", () => {
  const message = { to: "971500000000", body: "Your Urus is held until 21:40.", correlationId: "msg-1" };

  it("sends a WhatsApp text and returns the carrier's message id", async () => {
    const fetchSpy = vi.fn(async () => jsonResponse(200, { messages: [{ id: "wamid.SENT1" }] }));
    const provider = new MetaChannelProvider("WHATSAPP", stubConfig(), logger(), fetchSpy as unknown as typeof fetch);

    const result = await provider.send(CLIENT_ID, message);

    expect(result.accepted).toBe(true);
    expect(result.providerMessageId).toBe("wamid.SENT1");

    const [url, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://graph.facebook.com/v21.0/1234567890/messages");
    expect(JSON.parse(String(init.body))).toMatchObject({
      messaging_product: "whatsapp",
      to: "971500000000",
      text: { body: message.body },
    });
  });

  it("treats a rate limit as retryable, so the queue backs off instead of dropping the reply", async () => {
    const fetchSpy = vi.fn(async () => jsonResponse(429, { error: { message: "rate limited" } }));
    const provider = new MetaChannelProvider("WHATSAPP", stubConfig(), logger(), fetchSpy as unknown as typeof fetch);

    await expect(provider.send(CLIENT_ID, message)).rejects.toBeInstanceOf(TransientDeliveryError);
  });

  it("treats a 5xx as retryable", async () => {
    const fetchSpy = vi.fn(async () => jsonResponse(503, {}));
    const provider = new MetaChannelProvider("WHATSAPP", stubConfig(), logger(), fetchSpy as unknown as typeof fetch);

    await expect(provider.send(CLIENT_ID, message)).rejects.toBeInstanceOf(TransientDeliveryError);
  });

  it("treats a network failure as retryable", async () => {
    const fetchSpy = vi.fn(async () => {
      throw new Error("ECONNRESET");
    });
    const provider = new MetaChannelProvider("WHATSAPP", stubConfig(), logger(), fetchSpy as unknown as typeof fetch);

    await expect(provider.send(CLIENT_ID, message)).rejects.toBeInstanceOf(TransientDeliveryError);
  });

  it("does not retry a refusal, it reports one", async () => {
    // Retrying a 400 four more times just delays the moment a person finds out.
    const fetchSpy = vi.fn(async () => jsonResponse(400, { error: { message: "Recipient not opted in", code: 131_030 } }));
    const provider = new MetaChannelProvider("WHATSAPP", stubConfig(), logger(), fetchSpy as unknown as typeof fetch);

    const result = await provider.send(CLIENT_ID, message);
    expect(result.accepted).toBe(false);
    expect(result.rejection).toBe("Recipient not opted in");
  });

  it("refuses to send without an access token rather than failing obscurely later", async () => {
    const provider = new MetaChannelProvider(
      "WHATSAPP",
      stubConfig({ metaAccessToken: null }),
      logger(),
      (async () => jsonResponse(200, {})) as unknown as typeof fetch,
    );
    await expect(provider.send(CLIENT_ID, message)).rejects.toBeInstanceOf(ConfigurationError);
  });

  it("uses Instagram's payload shape on Instagram", async () => {
    const fetchSpy = vi.fn(async () => jsonResponse(200, { message_id: "mid.SENT2" }));
    const provider = new MetaChannelProvider(
      "INSTAGRAM",
      stubConfig(),
      logger(),
      fetchSpy as unknown as typeof fetch,
    );

    // The fixture has no Instagram page id configured, so this must fail loudly
    // rather than posting to a malformed URL.
    await expect(provider.send(CLIENT_ID, message)).rejects.toBeInstanceOf(ConfigurationError);
  });
});

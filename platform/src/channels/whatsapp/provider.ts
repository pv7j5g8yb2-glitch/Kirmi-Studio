import { createHmac, timingSafeEqual } from "node:crypto";
import { request } from "undici";
import { env } from "../../config/env.js";
import type { MessagingProvider, OutboundTemplate, OutboundText, SendResult, NormalisedInbound } from "../types.js";

/**
 * Meta Cloud API signs every webhook body with the app secret. We verify over the
 * RAW bytes — re-serialising the parsed JSON changes key order and whitespace and
 * would fail for legitimate requests, so Fastify is configured to keep the raw buffer.
 */
export function verifySignature(rawBody: Buffer | string, header: string | undefined, appSecret: string): boolean {
  if (!header) return false;
  const expected = header.startsWith("sha256=") ? header.slice(7) : header;
  const digest = createHmac("sha256", appSecret).update(rawBody).digest("hex");
  const a = Buffer.from(digest, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** Meta's GET handshake when a webhook URL is first registered. */
export function verifyChallenge(
  params: { mode?: string; token?: string; challenge?: string },
  verifyToken: string,
): { ok: true; challenge: string } | { ok: false } {
  if (params.mode === "subscribe" && params.token && params.challenge && params.token === verifyToken) {
    return { ok: true, challenge: params.challenge };
  }
  return { ok: false };
}

type CloudEnvelope = {
  object?: string;
  entry?: Array<{
    id?: string;
    changes?: Array<{
      field?: string;
      value?: {
        metadata?: { phone_number_id?: string; display_phone_number?: string };
        contacts?: Array<{ wa_id?: string; profile?: { name?: string } }>;
        messages?: Array<{
          id?: string; from?: string; timestamp?: string; type?: string;
          text?: { body?: string };
          button?: { text?: string };
          interactive?: { list_reply?: { title?: string }; button_reply?: { title?: string } };
        }>;
        statuses?: Array<{ id?: string; status?: string; recipient_id?: string; errors?: unknown }>;
      };
    }>;
  }>;
};

export type ParsedWebhook = {
  messages: NormalisedInbound[];
  statuses: Array<{ providerMessageId: string; status: string }>;
};

/** Pulls the handful of fields we act on out of Meta's deeply nested envelope. */
export function parseWebhook(body: unknown): ParsedWebhook {
  const env_ = (body ?? {}) as CloudEnvelope;
  const messages: NormalisedInbound[] = [];
  const statuses: ParsedWebhook["statuses"] = [];

  for (const entry of env_.entry ?? []) {
    for (const change of entry.changes ?? []) {
      const value = change.value;
      if (!value) continue;
      const to = value.metadata?.phone_number_id ?? "";
      const nameByWaId = new Map<string, string>();
      for (const c of value.contacts ?? []) {
        if (c.wa_id && c.profile?.name) nameByWaId.set(c.wa_id, c.profile.name);
      }
      for (const m of value.messages ?? []) {
        if (!m.id || !m.from) continue;
        const text =
          m.text?.body ??
          m.interactive?.button_reply?.title ??
          m.interactive?.list_reply?.title ??
          m.button?.text ??
          null;
        messages.push({
          channel: "whatsapp",
          providerMessageId: m.id,
          from: m.from,
          to,
          text,
          displayName: nameByWaId.get(m.from) ?? null,
          timestamp: m.timestamp ? new Date(Number(m.timestamp) * 1000) : new Date(),
          raw: m as Record<string, unknown>,
        });
      }
      for (const s of value.statuses ?? []) {
        if (s.id && s.status) statuses.push({ providerMessageId: s.id, status: s.status });
      }
    }
  }
  return { messages, statuses };
}

const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);

export class WhatsAppCloudProvider implements MessagingProvider {
  readonly name = "whatsapp_cloud";

  constructor(
    private readonly cfg = {
      token: env().WHATSAPP_ACCESS_TOKEN,
      phoneNumberId: env().WHATSAPP_PHONE_NUMBER_ID,
      apiVersion: env().WHATSAPP_API_VERSION,
      base: env().WHATSAPP_GRAPH_BASE,
    },
  ) {}

  isConfigured(): boolean {
    return Boolean(this.cfg.token && this.cfg.phoneNumberId);
  }

  private async post(payload: Record<string, unknown>): Promise<SendResult> {
    if (!this.isConfigured()) {
      return { ok: false, retryable: true, error: "WhatsApp is NOT_CONNECTED: no access token or phone number id" };
    }
    const url = `${this.cfg.base}/${this.cfg.apiVersion}/${this.cfg.phoneNumberId}/messages`;
    try {
      const res = await request(url, {
        method: "POST",
        headers: { authorization: `Bearer ${this.cfg.token}`, "content-type": "application/json" },
        body: JSON.stringify(payload),
        headersTimeout: 15_000,
        bodyTimeout: 15_000,
      });
      const text = await res.body.text();
      if (res.statusCode >= 200 && res.statusCode < 300) {
        const parsed = JSON.parse(text) as { messages?: Array<{ id?: string }> };
        return { ok: true, providerMessageId: parsed.messages?.[0]?.id ?? "unknown" };
      }
      return {
        ok: false,
        retryable: RETRYABLE_STATUS.has(res.statusCode),
        error: `Meta responded ${res.statusCode}: ${text.slice(0, 400)}`,
        status: res.statusCode,
      };
    } catch (e) {
      // Network-level failure: always worth another attempt.
      return { ok: false, retryable: true, error: (e as Error).message };
    }
  }

  async sendText(msg: OutboundText): Promise<SendResult> {
    return this.post({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: msg.to,
      type: "text",
      text: { preview_url: false, body: msg.body },
    });
  }

  async sendTemplate(msg: OutboundTemplate): Promise<SendResult> {
    return this.post({
      messaging_product: "whatsapp",
      to: msg.to,
      type: "template",
      template: {
        name: msg.templateName,
        language: { code: msg.languageCode },
        components: msg.variables?.length
          ? [{ type: "body", parameters: msg.variables.map((v) => ({ type: "text", text: v })) }]
          : [],
      },
    });
  }
}

/** In-memory provider used by tests and DEMO tenants. Never talks to Meta. */
export class MockMessagingProvider implements MessagingProvider {
  readonly name = "mock";
  readonly sent: Array<OutboundText | OutboundTemplate> = [];
  private failTimes = 0;

  constructor(private readonly configured = true) {}
  failNext(n: number): void { this.failTimes = n; }
  isConfigured(): boolean { return this.configured; }

  async sendText(msg: OutboundText): Promise<SendResult> {
    if (this.failTimes > 0) { this.failTimes--; return { ok: false, retryable: true, error: "simulated transient failure" }; }
    this.sent.push(msg);
    return { ok: true, providerMessageId: `mock-${this.sent.length}` };
  }

  async sendTemplate(msg: OutboundTemplate): Promise<SendResult> {
    if (this.failTimes > 0) { this.failTimes--; return { ok: false, retryable: true, error: "simulated transient failure" }; }
    this.sent.push(msg);
    return { ok: true, providerMessageId: `mock-tpl-${this.sent.length}` };
  }
}

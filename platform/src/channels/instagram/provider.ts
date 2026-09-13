import { request } from "undici";
import { env } from "../../config/env.js";
import type { MessagingProvider, OutboundText, SendResult, NormalisedInbound } from "../types.js";

/**
 * Instagram Messaging rides the same Graph webhook shape as Messenger: entry[].messaging[].
 * Echo messages (our own sends coming back) are dropped, otherwise the engine would
 * answer itself.
 */
type IgEnvelope = {
  object?: string;
  entry?: Array<{
    id?: string;
    time?: number;
    messaging?: Array<{
      sender?: { id?: string };
      recipient?: { id?: string };
      timestamp?: number;
      message?: { mid?: string; text?: string; is_echo?: boolean };
    }>;
  }>;
};

export function parseInstagramWebhook(body: unknown): NormalisedInbound[] {
  const env_ = (body ?? {}) as IgEnvelope;
  const out: NormalisedInbound[] = [];
  for (const entry of env_.entry ?? []) {
    for (const ev of entry.messaging ?? []) {
      const msg = ev.message;
      if (!msg?.mid || msg.is_echo) continue;
      if (!ev.sender?.id) continue;
      out.push({
        channel: "instagram",
        providerMessageId: msg.mid,
        from: ev.sender.id,
        to: ev.recipient?.id ?? entry.id ?? "",
        text: msg.text ?? null,
        displayName: null,
        timestamp: ev.timestamp ? new Date(ev.timestamp) : new Date(),
        raw: ev as Record<string, unknown>,
      });
    }
  }
  return out;
}

const RETRYABLE = new Set([408, 429, 500, 502, 503, 504]);

export class InstagramProvider implements MessagingProvider {
  readonly name = "instagram_graph";

  constructor(
    private readonly cfg = {
      token: env().INSTAGRAM_ACCESS_TOKEN,
      accountId: env().INSTAGRAM_ACCOUNT_ID,
      apiVersion: env().WHATSAPP_API_VERSION,
      base: env().WHATSAPP_GRAPH_BASE,
    },
  ) {}

  isConfigured(): boolean {
    return Boolean(this.cfg.token && this.cfg.accountId);
  }

  async sendText(msg: OutboundText): Promise<SendResult> {
    if (!this.isConfigured()) {
      return { ok: false, retryable: true, error: "Instagram is NOT_CONNECTED: no access token or account id" };
    }
    const url = `${this.cfg.base}/${this.cfg.apiVersion}/${this.cfg.accountId}/messages`;
    try {
      const res = await request(url, {
        method: "POST",
        headers: { authorization: `Bearer ${this.cfg.token}`, "content-type": "application/json" },
        body: JSON.stringify({ recipient: { id: msg.to }, message: { text: msg.body } }),
        headersTimeout: 15_000,
        bodyTimeout: 15_000,
      });
      const text = await res.body.text();
      if (res.statusCode >= 200 && res.statusCode < 300) {
        const parsed = JSON.parse(text) as { message_id?: string };
        return { ok: true, providerMessageId: parsed.message_id ?? "unknown" };
      }
      return { ok: false, retryable: RETRYABLE.has(res.statusCode), error: `Graph ${res.statusCode}: ${text.slice(0, 300)}`, status: res.statusCode };
    } catch (e) {
      return { ok: false, retryable: true, error: (e as Error).message };
    }
  }
}

/** Shared shape every messaging channel implements, so the engine is channel-agnostic. */

export type NormalisedInbound = {
  channel: "whatsapp" | "instagram";
  /** Provider's own message id — the idempotency key for replays. */
  providerMessageId: string;
  /** E.164 for WhatsApp, IGSID for Instagram. */
  from: string;
  /** The account the message arrived at (phone_number_id / ig account id). */
  to: string;
  text: string | null;
  displayName: string | null;
  timestamp: Date;
  raw: Record<string, unknown>;
};

export type SendResult =
  | { ok: true; providerMessageId: string }
  | { ok: false; retryable: boolean; error: string; status?: number };

export type OutboundText = {
  to: string;
  body: string;
};

export type OutboundTemplate = {
  to: string;
  templateName: string;
  languageCode: string;
  variables?: string[];
};

export interface MessagingProvider {
  readonly name: string;
  /** False when credentials are absent; the outbox then parks messages instead of failing them. */
  isConfigured(): boolean;
  sendText(msg: OutboundText): Promise<SendResult>;
  sendTemplate?(msg: OutboundTemplate): Promise<SendResult>;
}

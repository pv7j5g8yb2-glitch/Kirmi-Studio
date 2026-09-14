import type { OutboundMedia, OutboundTemplate } from "../channels/types.js";
import { QUEUE_NAMES } from "../config/constants.js";
import type { OutboundDispatcher } from "../orchestrator/message.pipeline.js";
import { enqueue } from "./queues.js";

/** The production dispatcher: hands the reply to the delivery queue. */
export class QueueOutboundDispatcher implements OutboundDispatcher {
  async dispatch(job: {
    clientId: string;
    conversationId: string;
    messageId: string;
    channel: "WHATSAPP" | "INSTAGRAM" | "TELEPHONY" | "WEB" | "SMS";
    to: string;
    body: string;
    media?: OutboundMedia[];
    template?: OutboundTemplate;
    allowSmsFallback?: boolean;
  }): Promise<void> {
    await enqueue(QUEUE_NAMES.outboundDelivery, job, {
      // Keyed on our own message id: a retried pipeline run cannot send the
      // same reply to the customer twice.
      dedupeId: `send:${job.clientId}:${job.messageId}`,
    });
  }
}

/** Used by tests and by any process that composes replies without sending them. */
export class RecordingDispatcher implements OutboundDispatcher {
  public readonly dispatched: Array<{
    messageId: string;
    to: string;
    body: string;
    media?: OutboundMedia[];
    template?: OutboundTemplate;
  }> = [];
  async dispatch(job: {
    messageId: string;
    to: string;
    body: string;
    media?: OutboundMedia[];
    template?: OutboundTemplate;
  }): Promise<void> {
    this.dispatched.push({
      messageId: job.messageId,
      to: job.to,
      body: job.body,
      ...(job.media ? { media: job.media } : {}),
      ...(job.template ? { template: job.template } : {}),
    });
  }
}

import type { Server as HttpServer } from "node:http";
import { createContextCache, type ContextCache } from "../cache/conversation-context.cache.js";
import { ChannelRegistry } from "../channels/registry.js";
import { createIdempotencyStore, type IdempotencyStore } from "../cache/idempotency.js";
import { tenantDatabase, type TenantDatabase } from "../db/tenant-context.js";
import { QueueOutboundDispatcher } from "../queue/outbound-dispatcher.js";
import { AnthropicLlmClient, type LlmClient } from "../orchestrator/llm.client.js";
import { MessagePipeline, type OutboundDispatcher } from "../orchestrator/message.pipeline.js";
import { ToolExecutor } from "../orchestrator/tool-executor.js";
import { InboxGateway, NullBroadcaster } from "../realtime/websocket.gateway.js";
import { AttributionService } from "../services/attribution.service.js";
import { AuditService } from "../services/audit.service.js";
import { FollowUpService } from "../services/follow-up.service.js";
import { ClientConfigService } from "../services/client-config.service.js";
import { ConversationService } from "../services/conversation.service.js";
import { CustomerService } from "../services/customer.service.js";
import { EscalationService, type EscalationBroadcaster } from "../services/escalation.service.js";
import { MetricsService } from "../services/metrics.service.js";
import { QuoteService } from "../services/quote.service.js";
import { ReservationService } from "../services/reservation.service.js";
import { VehicleService } from "../services/vehicle.service.js";
import { WebhookService } from "../services/webhook.service.js";
import { logger, type Logger } from "./logger.js";

/**
 * ===========================================================================
 * COMPOSITION ROOT
 * ===========================================================================
 *
 * Every dependency in this service is wired in exactly one place: here.
 *
 * No service imports a singleton, reaches for a global, or constructs its own
 * collaborators. They take what they need as constructor arguments and are
 * given it once, at startup. That is the whole of the dependency injection
 * story, and it buys two concrete things.
 *
 * A test can build any service with fakes and no infrastructure. The
 * reservation race test hands ReservationService a real database and a stub
 * logger; the pricing tests need neither.
 *
 * And the wiring is readable. Every arrow in the architecture diagram is a
 * line in this file, so "what talks to what" is answered by reading forty
 * lines rather than by grepping for imports.
 */
export interface Container {
  log: Logger;
  db: TenantDatabase;
  cache: ContextCache;
  idempotency: IdempotencyStore;
  broadcaster: EscalationBroadcaster;

  config: ClientConfigService;
  audit: AuditService;
  customers: CustomerService;
  conversations: ConversationService;
  vehicles: VehicleService;
  quotes: QuoteService;
  reservations: ReservationService;
  escalations: EscalationService;
  followUps: FollowUpService;
  attribution: AttributionService;
  metrics: MetricsService;
  webhooks: WebhookService;

  channels: ChannelRegistry;
  dispatcher: OutboundDispatcher;
  llm: LlmClient;
  tools: ToolExecutor;
  pipeline: MessagePipeline;

  /** Present only in the API process; the worker process has no socket server. */
  gateway: InboxGateway | null;
}

export interface ContainerOptions {
  /** Attaching the inbox socket. Omitted by the queue worker. */
  httpServer?: HttpServer;
  /** Overridden by tests with a scripted model, so the pipeline runs offline. */
  llm?: LlmClient;
  db?: TenantDatabase;
  cache?: ContextCache;
  idempotency?: IdempotencyStore;
  /** Replaced in tests to assert that a takeover was actually broadcast. */
  broadcaster?: EscalationBroadcaster;
  /** Replaced in tests so a reply is composed and recorded but never sent. */
  dispatcher?: OutboundDispatcher;
}

export function buildContainer(options: ContainerOptions = {}): Container {
  const log = logger();

  // --- infrastructure ----------------------------------------------------
  const db = options.db ?? tenantDatabase;
  const cache = options.cache ?? createContextCache();
  const idempotency = options.idempotency ?? createIdempotencyStore();

  // --- the configuration layer, which everything tenant aware depends on --
  const config = new ClientConfigService(db, cache, log);

  // The socket gateway needs db and config, and the escalation service needs
  // the gateway, so it is built here in between rather than in server.ts.
  const gateway = options.httpServer ? new InboxGateway(options.httpServer, db, config, log) : null;
  const broadcaster: EscalationBroadcaster = options.broadcaster ?? gateway ?? new NullBroadcaster(log);

  // --- domain services ----------------------------------------------------
  const audit = new AuditService();
  const customers = new CustomerService();
  const conversations = new ConversationService();
  const vehicles = new VehicleService();
  const quotes = new QuoteService(db, vehicles, audit);
  const reservations = new ReservationService(db, vehicles, audit, log);
  const escalations = new EscalationService(db, audit, broadcaster, log);
  const followUps = new FollowUpService(db, log);
  const attribution = new AttributionService(db, log);
  const metrics = new MetricsService(db);
  const webhooks = new WebhookService(db, audit);

  // --- channels and the agent layer ---------------------------------------
  const channels = new ChannelRegistry(config, log);
  const dispatcher = options.dispatcher ?? new QueueOutboundDispatcher();
  const llm = options.llm ?? new AnthropicLlmClient(log);
  const tools = new ToolExecutor(db, vehicles, quotes, reservations, customers, log, config);
  const pipeline = new MessagePipeline(
    db, customers, conversations, escalations, tools, llm, cache, audit, dispatcher, log, followUps,
  );

  return {
    log,
    db,
    cache,
    idempotency,
    broadcaster,
    config,
    audit,
    customers,
    conversations,
    vehicles,
    quotes,
    reservations,
    escalations,
    followUps,
    attribution,
    metrics,
    webhooks,
    channels,
    dispatcher,
    llm,
    tools,
    pipeline,
    gateway,
  };
}

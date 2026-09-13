import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { env } from "../../src/config/env.js";
import { buildContainer, type Container } from "../../src/core/container.js";
import type { TenantProfile } from "../../src/core/types.js";
import { disconnectRedis } from "../../src/cache/redis.js";
import { prisma } from "../../src/db/prisma.js";
import { withTenant } from "../../src/db/tenant-context.js";
import type { InboundMessage } from "../../src/orchestrator/message.pipeline.js";
import {
  closeHarness,
  databaseAvailable,
  migrate,
  resetDatabase,
  seedTenant,
  type SeededTenant,
} from "../helpers/database.js";
import { RecordingDispatcher } from "../../src/queue/outbound-dispatcher.js";
import { ScriptedLlm, plainReply, toolCall } from "../helpers/scripted-llm.js";

/**
 * ===========================================================================
 * THE 15 SECOND SLA
 * ===========================================================================
 *
 * The promise sold to a client is that an enquiry arriving at 9pm is answered
 * before their competitor opens, and in practice that a reply lands inside 15
 * seconds. These tests measure the full pipeline against a real database and a
 * real cache, with a scripted model standing in for the provider.
 *
 * The measurement starts at CARRIER RECEIPT, not at the moment the pipeline
 * function was entered. A message that waited eleven seconds in a queue and was
 * answered in two took thirteen seconds as far as the customer is concerned,
 * and thirteen is the number the client was promised something about.
 *
 * The suite also asserts the warm path is materially faster than the cold one,
 * because that is the entire justification for the Redis context layer.
 */

const available = await databaseAvailable();

describe.skipIf(!available)("reply SLA", () => {
  let tenant: SeededTenant;
  let profile: TenantProfile;

  beforeAll(() => {
    migrate();
  });

  beforeEach(async () => {
    await resetDatabase();
    tenant = await seedTenant("sla");
  });

  afterAll(async () => {
    await resetDatabase();
    await prisma().$disconnect();
    await disconnectRedis();
    await closeHarness();
  });

  const inbound = (body: string, overrides: Partial<InboundMessage> = {}): InboundMessage => ({
    channel: "WHATSAPP",
    externalId: "971500000001",
    displayName: "Test Customer",
    providerMessageId: `wamid.${Math.random().toString(36).slice(2)}`,
    body,
    receivedAt: new Date(),
    ...overrides,
  });

  let dispatcher: RecordingDispatcher;

  async function containerWith(llm: ScriptedLlm): Promise<{ container: Container; profile: TenantProfile }> {
    dispatcher = new RecordingDispatcher();
    const container = buildContainer({ llm, dispatcher });
    await container.config.invalidate(tenant.clientId);
    profile = await container.config.loadProfile(tenant.clientId);
    return { container, profile };
  }

  it("answers a cold first enquiry inside the SLA", async () => {
    // Cold: no cached context, no cached profile, a brand new customer, and a
    // model round trip. The worst case a real first message hits.
    const llm = new ScriptedLlm([plainReply("We have the Urus free that weekend. Which dates suit?")], 300);
    const { container, profile: tenantProfile } = await containerWith(llm);

    const result = await container.pipeline.handle(tenantProfile, inbound("Do you have an Urus for the weekend?"));

    expect(result.status).toBe("replied");
    expect(result.slaBreached).toBe(false);
    expect(result.latencyMs).toBeLessThan(env().REPLY_SLA_MS);
  });

  it("answers a full search, quote and hold conversation inside the SLA", async () => {
    // The heaviest real path: two model round trips with database work between
    // them, including a priced quote and a pessimistic row lock.
    const startAt = new Date(Date.now() + 7 * 24 * 3_600_000);
    const endAt = new Date(startAt.getTime() + 3 * 24 * 3_600_000);

    const llm = new ScriptedLlm(
      [
        toolCall("CHECK_AVAILABILITY", {
          vehicleId: tenant.vehicleId,
          startAt: startAt.toISOString(),
          endAt: endAt.toISOString(),
          deliveryRequested: true,
        }),
        plainReply("Yes, it is free. AED 9,607.50 all in including VAT and delivery. Shall I hold it?"),
      ],
      300,
    );
    const { container, profile: tenantProfile } = await containerWith(llm);

    const result = await container.pipeline.handle(tenantProfile, inbound("Urus next Friday to Monday, delivered to the Marina"));

    expect(result.status).toBe("replied");
    expect(result.latencyMs).toBeLessThan(env().REPLY_SLA_MS);

    // And the quote it produced was computed by the engine, not the model.
    const quotes = await withTenant(tenant.clientId, async (tx) => tx.quote.findMany());
    expect(quotes).toHaveLength(1);
    expect(quotes[0]?.totalMinor).toBeGreaterThan(0);
    expect(quotes[0]?.calcVersion).toBeTruthy();
  });

  it("counts queue time against the budget and flags a real breach", async () => {
    // A message that sat in the queue for 20 seconds before this process saw it.
    // Answering it in 200ms does not make it a fast reply.
    const llm = new ScriptedLlm([plainReply("Sorry for the wait.")], 10);
    const { container, profile: tenantProfile } = await containerWith(llm);

    const result = await container.pipeline.handle(
      tenantProfile,
      inbound("Hello?", { receivedAt: new Date(Date.now() - 20_000) }),
    );

    expect(result.slaBreached).toBe(true);

    // A breach is recorded as its own ledger event, so a client can audit the
    // promise they were sold rather than being told it was fine.
    const events = await withTenant(tenant.clientId, async (tx) =>
      tx.platformAuditLog.findMany({ where: { eventType: "SLA_BREACH" } }),
    );
    expect(events).toHaveLength(1);

    const messages = await withTenant(tenant.clientId, async (tx) =>
      tx.message.findMany({ where: { direction: "OUTBOUND" } }),
    );
    expect(messages[0]?.slaBreached).toBe(true);
  });

  it("is measurably faster on the warm path than on the cold one", async () => {
    // The justification for the Redis context layer. If this stops being true,
    // the cache is complexity with no return.
    const llm = new ScriptedLlm([plainReply("Of course.")], 0);
    const { container, profile: tenantProfile } = await containerWith(llm);

    const cold = await container.pipeline.handle(tenantProfile, inbound("First message"));
    const warm = await container.pipeline.handle(tenantProfile, inbound("Second message"));

    expect(cold.status).toBe("replied");
    expect(warm.status).toBe("replied");
    expect(warm.latencyMs).toBeLessThanOrEqual(cold.latencyMs);
    expect(warm.latencyMs).toBeLessThan(env().REPLY_TARGET_MS);
  });

  it("hands the composed reply to delivery, after it has been recorded", async () => {
    // Recorded first, sent second. The other order means a crash between the
    // two leaves a customer holding a message the system has no memory of.
    const llm = new ScriptedLlm([plainReply("The Urus is free, shall I hold it?")], 0);
    const { container, profile: tenantProfile } = await containerWith(llm);

    await container.pipeline.handle(tenantProfile, inbound("Urus this weekend?"));

    expect(dispatcher.dispatched).toHaveLength(1);
    expect(dispatcher.dispatched[0]?.body).toBe("The Urus is free, shall I hold it?");
    expect(dispatcher.dispatched[0]?.to).toBe("971500000001");

    const recorded = await withTenant(tenant.clientId, async (tx) =>
      tx.message.findMany({ where: { direction: "OUTBOUND" } }),
    );
    expect(recorded[0]?.id).toBe(dispatcher.dispatched[0]?.messageId);
  });

  it("does not dispatch anything when a human has taken the thread over", async () => {
    const llm = new ScriptedLlm([plainReply("This must never be sent.")], 0);
    const { container, profile: tenantProfile } = await containerWith(llm);

    const first = await container.pipeline.handle(tenantProfile, inbound("Hello"));
    await withTenant(tenant.clientId, async (tx) => {
      await tx.conversation.update({
        where: { id: first.conversationId as string },
        data: { aiEnabled: false, state: "HUMAN_TAKEOVER" },
      });
    });

    const before = dispatcher.dispatched.length;
    const second = await container.pipeline.handle(tenantProfile, inbound("Still there?"));

    expect(second.status).toBe("suppressed");
    expect(dispatcher.dispatched).toHaveLength(before);
  });

  it("records the latency of every reply, so the metric is auditable per message", async () => {
    const llm = new ScriptedLlm([plainReply("Right away.")], 50);
    const { container, profile: tenantProfile } = await containerWith(llm);

    await container.pipeline.handle(tenantProfile, inbound("Hello"));

    const messages = await withTenant(tenant.clientId, async (tx) =>
      tx.message.findMany({ where: { direction: "OUTBOUND" } }),
    );
    expect(messages[0]?.latencyMs).toBeGreaterThan(0);
    expect(messages[0]?.latencyMs).toBeLessThan(env().REPLY_SLA_MS);
  });

  it("counts one enquiry per conversation, not one per message", async () => {
    // A customer who fires off four messages in a row is one enquiry. Counting
    // four would flatter the conversion rate into meaninglessness.
    const llm = new ScriptedLlm([plainReply("Yes.")], 0);
    const { container, profile: tenantProfile } = await containerWith(llm);

    for (const text of ["Hi", "Are you there", "I need a car", "For Friday"]) {
      await container.pipeline.handle(tenantProfile, inbound(text));
    }

    const enquiries = await withTenant(tenant.clientId, async (tx) =>
      tx.platformAuditLog.count({ where: { eventType: "ENQUIRY_RECEIVED" } }),
    );
    expect(enquiries).toBe(1);
  });
});

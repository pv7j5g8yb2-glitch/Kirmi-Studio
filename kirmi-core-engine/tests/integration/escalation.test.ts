import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildContainer } from "../../src/core/container.js";
import type { TenantProfile } from "../../src/core/types.js";
import { disconnectRedis } from "../../src/cache/redis.js";
import { prisma } from "../../src/db/prisma.js";
import { withTenant } from "../../src/db/tenant-context.js";
import type { EscalationBroadcaster, EscalationEvent } from "../../src/services/escalation.service.js";
import { closeHarness, databaseAvailable, migrate, resetDatabase, seedTenant, type SeededTenant } from "../helpers/database.js";
import { RecordingDispatcher } from "../../src/queue/outbound-dispatcher.js";
import { ScriptedLlm, plainReply, toolCall } from "../helpers/scripted-llm.js";

/**
 * ===========================================================================
 * THE HUMAN CONCIERGE HANDOFF
 * ===========================================================================
 *
 * Two properties, and the second is the one people get wrong.
 *
 *   1. A failed qualification flips aiEnabled to false, records an escalation
 *      and pushes it to the inbox.
 *   2. Flipping that switch stops the agent even mid reply. A human who hits
 *      take over while the model is still generating must not then watch the
 *      agent get one last message in.
 */

const available = await databaseAvailable();

class RecordingBroadcaster implements EscalationBroadcaster {
  public readonly events: Array<{ clientId: string; event: EscalationEvent }> = [];
  publish(clientId: string, event: EscalationEvent): void {
    this.events.push({ clientId, event });
  }
}

describe.skipIf(!available)("human takeover", () => {
  let tenant: SeededTenant;
  let profile: TenantProfile;
  let broadcaster: RecordingBroadcaster;

  beforeAll(() => {
    migrate();
  });

  beforeEach(async () => {
    await resetDatabase();
    tenant = await seedTenant("concierge");
    broadcaster = new RecordingBroadcaster();
  });

  afterAll(async () => {
    await resetDatabase();
    await prisma().$disconnect();
    await disconnectRedis();
    await closeHarness();
  });

  const inbound = (body: string) => ({
    channel: "WHATSAPP" as const,
    externalId: "971500000002",
    providerMessageId: `wamid.${Math.random().toString(36).slice(2)}`,
    body,
    receivedAt: new Date(),
  });

  it("escalates an under age driver instead of quoting them", async () => {
    // A 22 year old asking for a supercar. The right outcome is a person, not
    // a well worded refusal, and certainly not a quote withdrawn afterwards.
    const startAt = new Date(Date.now() + 7 * 24 * 3_600_000);
    const endAt = new Date(startAt.getTime() + 2 * 24 * 3_600_000);

    const llm = new ScriptedLlm([
      toolCall("CHECK_AVAILABILITY", {
        vehicleId: tenant.vehicleId,
        startAt: startAt.toISOString(),
        endAt: endAt.toISOString(),
      }),
      plainReply("should never be sent"),
    ]);

    const container = buildContainer({ llm, broadcaster, dispatcher: new RecordingDispatcher() });
    await container.config.invalidate(tenant.clientId);
    profile = await container.config.loadProfile(tenant.clientId);

    await withTenant(tenant.clientId, async (tx) => {
      await tx.customer.update({
        where: { id: tenant.customerId },
        data: { dateOfBirth: new Date(`${new Date().getUTCFullYear() - 22}-01-01`) },
      });
    });

    // Resolve the seeded customer onto the channel handle the pipeline will use.
    await withTenant(tenant.clientId, async (tx) => {
      await tx.customerIdentity.create({
        data: { clientId: tenant.clientId, customerId: tenant.customerId, channel: "WHATSAPP", externalId: "971500000002" },
      });
    });

    const result = await container.pipeline.handle(profile, inbound("Can I take the Urus this weekend?"));

    expect(result.status).toBe("escalated");

    const conversation = await withTenant(tenant.clientId, async (tx) => tx.conversation.findFirst());
    expect(conversation?.aiEnabled).toBe(false);
    expect(conversation?.state).toBe("HUMAN_TAKEOVER");
    expect(conversation?.takeoverReason).toBe("AGE_BELOW_MINIMUM");

    // Persisted, so the handover survives a dashboard nobody has open.
    const escalations = await withTenant(tenant.clientId, async (tx) => tx.escalation.findMany());
    expect(escalations).toHaveLength(1);
    expect(escalations[0]?.status).toBe("OPEN");

    // And pushed, so somebody sees it now.
    expect(broadcaster.events).toHaveLength(1);
    expect(broadcaster.events[0]?.clientId).toBe(tenant.clientId);
    expect(broadcaster.events[0]?.event.reason).toBe("AGE_BELOW_MINIMUM");

    // No quote was produced and nothing was said to the customer.
    expect(await withTenant(tenant.clientId, async (tx) => tx.quote.count())).toBe(0);
    const outbound = await withTenant(tenant.clientId, async (tx) =>
      tx.message.findMany({ where: { direction: "OUTBOUND" } }),
    );
    expect(outbound).toHaveLength(0);
  });

  it("stands down on a thread a human has already taken over", async () => {
    const llm = new ScriptedLlm([plainReply("The agent should never send this.")]);
    const container = buildContainer({ llm, broadcaster, dispatcher: new RecordingDispatcher() });
    await container.config.invalidate(tenant.clientId);
    profile = await container.config.loadProfile(tenant.clientId);

    const first = await container.pipeline.handle(profile, inbound("Hello"));
    expect(first.status).toBe("replied");

    await withTenant(tenant.clientId, async (tx) => {
      await tx.conversation.update({
        where: { id: first.conversationId as string },
        data: { aiEnabled: false, state: "HUMAN_TAKEOVER", takeoverAt: new Date() },
      });
    });

    const second = await container.pipeline.handle(profile, inbound("Are you still there?"));
    expect(second.status).toBe("suppressed");

    // The inbound message is still recorded, because the human needs to read
    // it. Only the automated reply is suppressed.
    const messages = await withTenant(tenant.clientId, async (tx) => tx.message.findMany({ orderBy: { createdAt: "asc" } }));
    expect(messages.filter((m) => m.direction === "INBOUND")).toHaveLength(2);
    expect(messages.filter((m) => m.direction === "OUTBOUND")).toHaveLength(1);
  });

  it("suppresses a reply when the takeover lands mid flight", async () => {
    // The race that matters: the human hits take over while the model is still
    // generating. The check inside the writing transaction is what catches it.
    const container = buildContainer({ broadcaster, llm: new ScriptedLlm([plainReply("First")]), dispatcher: new RecordingDispatcher() });
    await container.config.invalidate(tenant.clientId);
    profile = await container.config.loadProfile(tenant.clientId);

    const opening = await container.pipeline.handle(profile, inbound("Hi"));
    const conversationId = opening.conversationId as string;

    // A model that takes 400ms, during which a human takes the thread.
    const slowLlm = new ScriptedLlm([plainReply("This reply must never reach the customer.")], 400);
    const racing = buildContainer({ llm: slowLlm, broadcaster, dispatcher: new RecordingDispatcher() });

    const replying = racing.pipeline.handle(profile, inbound("What about Saturday?"));

    await new Promise((resolve) => setTimeout(resolve, 120));
    await withTenant(tenant.clientId, async (tx) => {
      await tx.conversation.update({
        where: { id: conversationId },
        data: { aiEnabled: false, state: "HUMAN_TAKEOVER", takeoverAt: new Date() },
      });
    });

    const result = await replying;
    expect(result.status).toBe("suppressed");

    const outbound = await withTenant(tenant.clientId, async (tx) =>
      tx.message.findMany({ where: { direction: "OUTBOUND" } }),
    );
    expect(outbound.map((m) => m.body)).toEqual(["First"]);
  });

  it("hands the thread back only when a human says so", async () => {
    const container = buildContainer({ broadcaster, llm: new ScriptedLlm([plainReply("Hello")]), dispatcher: new RecordingDispatcher() });
    await container.config.invalidate(tenant.clientId);
    profile = await container.config.loadProfile(tenant.clientId);

    const opening = await container.pipeline.handle(profile, inbound("Hi"));
    const conversationId = opening.conversationId as string;

    const escalation = await container.escalations.escalate({
      tenant: profile,
      conversationId,
      reason: "CUSTOM_RATE_REQUEST",
      summary: "Customer asked for a rate that is not published",
    });

    // Resolving without handing back leaves the agent silent.
    await container.escalations.resolve(tenant.clientId, escalation.id, { reenableAi: false });
    let conversation = await withTenant(tenant.clientId, async (tx) => tx.conversation.findUnique({ where: { id: conversationId } }));
    expect(conversation?.aiEnabled).toBe(false);

    // Explicitly handing back re-enables it.
    const second = await container.escalations.escalate({
      tenant: profile,
      conversationId,
      reason: "CUSTOM_RATE_REQUEST",
      summary: "Second look",
    });
    await container.escalations.resolve(tenant.clientId, second.id, { reenableAi: true });
    conversation = await withTenant(tenant.clientId, async (tx) => tx.conversation.findUnique({ where: { id: conversationId } }));
    expect(conversation?.aiEnabled).toBe(true);
    expect(conversation?.state).toBe("QUALIFIED");
  });
});

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { FollowUpService } from "../../src/services/follow-up.service.js";
import { logger } from "../../src/core/logger.js";
import { tenantDatabase, withTenant } from "../../src/db/tenant-context.js";
import { ClientConfigService } from "../../src/services/client-config.service.js";
import { createContextCache } from "../../src/cache/conversation-context.cache.js";
import type { TenantProfile } from "../../src/core/types.js";
import { closeHarness, databaseAvailable, resetDatabase, seedTenant, type SeededTenant } from "../helpers/database.js";

/**
 * The follow up engine, against a real database.
 *
 * The unit tests cover the arithmetic. These cover the things only Postgres can
 * show: that scheduling is genuinely idempotent under a retry, that a reply
 * cancels a pending chase, and that one tenant's follow ups are invisible to
 * another even when the query does not filter on client id.
 */

const available = await databaseAvailable();

describe.skipIf(!available)("follow ups", () => {
  let tenant: SeededTenant;
  let profile: TenantProfile;
  let service: FollowUpService;
  let conversationId: string;

  beforeAll(() => {
    service = new FollowUpService(tenantDatabase, logger());
  });

  beforeEach(async () => {
    await resetDatabase();
    tenant = await seedTenant(`fu-${Date.now()}`);

    const config = new ClientConfigService(tenantDatabase, createContextCache(), logger());
    profile = await config.loadProfile(tenant.clientId);

    conversationId = await withTenant(tenant.clientId, async (tx) => {
      const c = await tx.conversation.create({
        data: {
          clientId: tenant.clientId,
          customerId: tenant.customerId,
          channel: "WHATSAPP",
          state: "QUALIFIED",
          lastInboundAt: new Date(),
        },
      });
      return c.id;
    });
  });

  afterAll(async () => {
    await closeHarness();
  });

  it("schedules a chase at the configured delay", async () => {
    const from = new Date("2026-09-14T09:00:00Z");
    const id = await service.schedule(profile, {
      clientId: tenant.clientId,
      conversationId,
      kind: "QUOTE_NO_REPLY",
      from,
    });
    expect(id).not.toBeNull();

    const row = await withTenant(tenant.clientId, async (tx) =>
      tx.followUp.findUniqueOrThrow({ where: { id: id! } }),
    );
    // 1,440 minutes after the quote.
    expect(row.dueAt.toISOString()).toBe("2026-09-15T09:00:00.000Z");
    expect(row.status).toBe("SCHEDULED");
  });

  it("is idempotent, so a retried pipeline run cannot chase a customer twice", async () => {
    const from = new Date();
    const first = await service.schedule(profile, { clientId: tenant.clientId, conversationId, kind: "QUOTE_NO_REPLY", from });
    const second = await service.schedule(profile, { clientId: tenant.clientId, conversationId, kind: "QUOTE_NO_REPLY", from });

    expect(second).toBe(first);
    const count = await withTenant(tenant.clientId, async (tx) =>
      tx.followUp.count({ where: { conversationId, status: "SCHEDULED" } }),
    );
    expect(count).toBe(1);
  });

  it("cancels every pending chase the moment the customer replies", async () => {
    await service.schedule(profile, { clientId: tenant.clientId, conversationId, kind: "QUOTE_NO_REPLY", from: new Date() });

    const cancelled = await service.cancelFor(tenant.clientId, conversationId, "customer replied");
    expect(cancelled).toBe(1);

    const row = await withTenant(tenant.clientId, async (tx) =>
      tx.followUp.findFirstOrThrow({ where: { conversationId } }),
    );
    expect(row.status).toBe("CANCELLED");
    expect(row.cancelledReason).toBe("customer replied");
  });

  it("refuses to schedule past the configured attempt ceiling", async () => {
    // maxAttempts is 2. A third chase is not persistence, it is the thing that
    // gets a client's number rated poorly by Meta.
    const third = await service.schedule(profile, {
      clientId: tenant.clientId,
      conversationId,
      kind: "QUOTE_NO_REPLY",
      from: new Date(),
      attempt: 3,
    });
    expect(third).toBeNull();
  });

  it("ignores a kind the client has not configured a rule for", async () => {
    const id = await service.schedule(profile, {
      clientId: tenant.clientId,
      conversationId,
      kind: "REACTIVATION",
      from: new Date(),
    });
    expect(id).toBeNull();
  });

  it("returns only what is actually due", async () => {
    await service.schedule(profile, {
      clientId: tenant.clientId,
      conversationId,
      kind: "QUOTE_NO_REPLY",
      from: new Date(),
    });

    const notYet = await service.due(tenant.clientId, new Date());
    expect(notYet).toHaveLength(0);

    const tomorrow = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000);
    const due = await service.due(tenant.clientId, tomorrow);
    expect(due).toHaveLength(1);
    expect(due[0]?.conversationId).toBe(conversationId);
  });

  it("keeps one tenant's follow ups invisible to another", async () => {
    await service.schedule(profile, { clientId: tenant.clientId, conversationId, kind: "QUOTE_NO_REPLY", from: new Date() });

    const other = await seedTenant(`fu-other-${Date.now()}`);
    const leaked = await withTenant(other.clientId, async (tx) =>
      // Deliberately unfiltered. Row level security is the only thing standing
      // between this query and another client's customers.
      tx.followUp.findMany({}),
    );
    expect(leaked).toHaveLength(0);
  });
});

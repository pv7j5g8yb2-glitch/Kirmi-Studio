import { query, withTenant } from "../db/index.js";
import { env } from "../config/env.js";
import { drainOutbox } from "../domain/outbox.js";
import { runDueFollowups, scheduleReactivations } from "../domain/followups.js";
import { expireStaleHolds } from "../domain/reservations.js";
import { releaseExpiredHolds } from "../domain/availability.js";
import { WhatsAppCloudProvider, MockMessagingProvider } from "../channels/whatsapp/provider.js";
import { InstagramProvider } from "../channels/instagram/provider.js";
import type { MessagingProvider } from "../channels/types.js";

type Logger = { info: (o: unknown, m?: string) => void; error: (o: unknown, m?: string) => void };

/**
 * Provider selection is per tenant mode: a DEMO tenant must never be able to send a
 * real message, whatever credentials happen to be present in the environment.
 */
export function providerFor(channel: "whatsapp" | "instagram", mode: "demo" | "production"): MessagingProvider {
  if (mode === "demo") return new MockMessagingProvider(true);
  return channel === "whatsapp" ? new WhatsAppCloudProvider() : new InstagramProvider();
}

export async function tickOnce(log?: Logger): Promise<Record<string, number>> {
  const totals = { sent: 0, failed: 0, dead: 0, skipped: 0, followups: 0, expired: 0, reactivations: 0 };
  const { rows: tenants } = await query(`SELECT id, mode FROM tenants WHERE status='active'`);

  for (const t of tenants) {
    try {
      await withTenant(t.id, async (db) => {
        const wa = await drainOutbox(db, t.id, providerFor("whatsapp", t.mode), { limit: 50 });
        totals.sent += wa.sent; totals.failed += wa.failed; totals.dead += wa.dead; totals.skipped += wa.skipped;

        const fu = await runDueFollowups(db, t.id, { approvedTemplates: approvedTemplates() });
        totals.followups += fu.sent;

        const expired = await expireStaleHolds(db, t.id);
        totals.expired += expired.length;
        await releaseExpiredHolds(db, t.id);
      });
    } catch (e) {
      log?.error({ err: e, tenantId: t.id }, "scheduler tick failed for tenant");
    }
  }
  return totals;
}

/** Templates approved in the Meta console. Empty until a WABA exists. */
function approvedTemplates(): string[] {
  const raw = process.env.WHATSAPP_APPROVED_TEMPLATES ?? "";
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}

export async function dailySweep(log?: Logger): Promise<number> {
  let total = 0;
  const { rows: tenants } = await query(`SELECT id FROM tenants WHERE status='active'`);
  for (const t of tenants) {
    try {
      total += await withTenant(t.id, (db) => scheduleReactivations(db, t.id));
    } catch (e) {
      log?.error({ err: e, tenantId: t.id }, "reactivation sweep failed");
    }
  }
  return total;
}

/**
 * In-process scheduler. Adequate for one node; the outbox uses FOR UPDATE SKIP LOCKED
 * so running several instances is safe when this moves to a worker dyno.
 */
export function startScheduler(log?: Logger): () => void {
  if (env().NODE_ENV === "test") return () => undefined;
  const fast = setInterval(() => {
    tickOnce(log).catch((e) => log?.error({ err: e }, "scheduler tick threw"));
  }, 15_000);
  const slow = setInterval(() => {
    dailySweep(log).catch((e) => log?.error({ err: e }, "daily sweep threw"));
  }, 6 * 60 * 60 * 1000);
  fast.unref?.();
  slow.unref?.();
  return () => { clearInterval(fast); clearInterval(slow); };
}

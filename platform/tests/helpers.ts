import { randomUUID } from "node:crypto";
import { withAdmin, withTenant, query, type Queryable } from "../src/db/index.js";
import { migrate } from "../src/db/migrate.js";
import { setSetting, type TenantRules } from "../src/domain/settings.js";
import { setIntegrationState } from "../src/core/integrations.js";

process.env.NODE_ENV = process.env.NODE_ENV ?? "test";
process.env.DATABASE_URL =
  process.env.DATABASE_URL ?? "postgresql://kirmi_app@/kirmi_test?host=/tmp&port=5433";
process.env.SESSION_SECRET = process.env.SESSION_SECRET ?? "test-secret-value-0123456789";
process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? "silent";

let checked = false;

/**
 * Tests connect as kirmi_app, which deliberately cannot create roles or tables —
 * that is the whole point of the role split. Migrations are run separately by the
 * owner (npm run migrate against the owner URL), so here we only assert the schema
 * is present and fail loudly if it is not.
 */
export async function ensureSchema(): Promise<void> {
  if (checked) return;
  const { rows } = await query(`SELECT to_regclass('public.tenants') AS t`);
  if (!rows[0]?.t) {
    throw new Error(
      "Test schema missing. Run migrations as the database owner first:\n" +
        "  DATABASE_URL='postgresql://kirmi@/kirmi_test?host=/tmp&port=5433' npm run migrate",
    );
  }
  checked = true;
}

export { migrate };

/** Wipe every tenant-scoped table between tests without dropping the schema. */
export async function resetDb(): Promise<void> {
  await ensureSchema();
  await withAdmin(async (db) => {
    await db.query(`TRUNCATE
      audit_log, webhook_events, outbox, followups, payments, documents,
      reservation_events, reservations, quotes, enquiries, messages, conversations,
      customers, vehicle_blocks, vehicles, integrations, tenant_settings,
      sessions, memberships, users, tenants CASCADE`);
  });
}

export async function createTenant(opts: {
  slug?: string;
  name?: string;
  mode?: "demo" | "production";
  rules?: Partial<TenantRules>;
} = {}): Promise<string> {
  const slug = opts.slug ?? `t-${randomUUID().slice(0, 8)}`;
  const { rows } = await query(
    `INSERT INTO tenants (slug, name, mode) VALUES ($1,$2,$3) RETURNING id`,
    [slug, opts.name ?? slug, opts.mode ?? "production"],
  );
  const id = rows[0].id as string;
  await withTenant(id, async (db) => {
    if (opts.rules) await setSetting(db, id, "rules", opts.rules, "client_provided");
    for (const ch of ["whatsapp", "instagram", "voice", "payments", "inventory", "llm"] as const) {
      await setIntegrationState(db, id, ch, "NOT_CONNECTED");
    }
  });
  return id;
}

export const asTenant = withTenant;
export type { Queryable };

export function daysFromNow(n: number, hour = 10): Date {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + n);
  d.setUTCHours(hour, 0, 0, 0);
  return d;
}

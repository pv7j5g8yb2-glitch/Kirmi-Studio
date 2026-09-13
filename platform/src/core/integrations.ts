import type { Queryable } from "../db/index.js";
import { audit } from "./audit.js";

export const CHANNELS = ["whatsapp", "instagram", "voice", "payments", "inventory", "llm"] as const;
export type Channel = (typeof CHANNELS)[number];

/** The exact five states the brief requires. Nothing is ever implicitly "working". */
export const STATES = ["NOT_CONNECTED", "CONFIGURING", "CONNECTED", "ERROR", "DISCONNECTED"] as const;
export type IntegrationState = (typeof STATES)[number];

export type Integration = {
  channel: Channel;
  state: IntegrationState;
  detail: string | null;
  requirements: string[];
  lastCheckedAt: string | null;
};

export async function listIntegrations(db: Queryable, tenantId: string): Promise<Integration[]> {
  const { rows } = await db.query(
    `SELECT channel, state, detail, requirements, last_checked_at
       FROM integrations WHERE tenant_id = $1 ORDER BY channel`,
    [tenantId],
  );
  return rows.map((r: any) => ({
    channel: r.channel,
    state: r.state,
    detail: r.detail,
    requirements: r.requirements ?? [],
    lastCheckedAt: r.last_checked_at ? new Date(r.last_checked_at).toISOString() : null,
  }));
}

export async function setIntegrationState(
  db: Queryable,
  tenantId: string,
  channel: Channel,
  state: IntegrationState,
  opts: { detail?: string; requirements?: string[] } = {},
): Promise<void> {
  await db.query(
    `INSERT INTO integrations (tenant_id, channel, state, detail, requirements, last_checked_at, updated_at)
     VALUES ($1,$2,$3,$4,$5, now(), now())
     ON CONFLICT (tenant_id, channel) DO UPDATE
       SET state = EXCLUDED.state,
           detail = EXCLUDED.detail,
           requirements = EXCLUDED.requirements,
           last_checked_at = now(),
           updated_at = now()`,
    [tenantId, channel, state, opts.detail ?? null, JSON.stringify(opts.requirements ?? [])],
  );
  await audit(
    { tenantId, actor: "system", action: "integration.state_changed", entity: "integration", entityId: channel, data: { state, detail: opts.detail } },
    db,
  );
}

export async function getIntegration(db: Queryable, tenantId: string, channel: Channel): Promise<Integration | null> {
  const all = await listIntegrations(db, tenantId);
  return all.find((i) => i.channel === channel) ?? null;
}

export async function isConnected(db: Queryable, tenantId: string, channel: Channel): Promise<boolean> {
  const i = await getIntegration(db, tenantId, channel);
  return i?.state === "CONNECTED";
}

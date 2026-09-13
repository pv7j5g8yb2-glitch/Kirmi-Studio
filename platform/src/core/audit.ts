import type { Queryable } from "../db/index.js";
import { query } from "../db/index.js";

export type AuditEntry = {
  tenantId?: string | null;
  actor: string;
  actorUserId?: string | null;
  action: string;
  entity?: string | null;
  entityId?: string | null;
  data?: Record<string, unknown>;
};

/**
 * audit_log is deliberately outside RLS: it is written from tenant-scoped and
 * admin contexts alike, and must never be suppressed by a missing session var.
 */
export async function audit(entry: AuditEntry, db?: Queryable): Promise<void> {
  const sql = `INSERT INTO audit_log (tenant_id, actor, actor_user_id, action, entity, entity_id, data)
               VALUES ($1,$2,$3,$4,$5,$6,$7)`;
  const values = [
    entry.tenantId ?? null,
    entry.actor,
    entry.actorUserId ?? null,
    entry.action,
    entry.entity ?? null,
    entry.entityId ?? null,
    JSON.stringify(entry.data ?? {}),
  ];
  if (db) await db.query(sql, values);
  else await query(sql, values);
}

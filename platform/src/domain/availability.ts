import type { Queryable } from "../db/index.js";
import { getRules } from "./settings.js";
import { listVehicles, type Vehicle } from "./vehicles.js";

export type AvailabilityResult = {
  vehicleId: string;
  available: boolean;
  /**
   * False whenever the tenant has no authoritative inventory source. The engine
   * must then phrase every answer as "subject to confirmation" — the brief forbids
   * asserting live availability we cannot actually see.
   */
  authoritative: boolean;
  conflictCount: number;
};

export function rentalDays(startsAt: Date, endsAt: Date): number {
  const ms = endsAt.getTime() - startsAt.getTime();
  if (ms <= 0) return 0;
  return Math.max(1, Math.ceil(ms / 86_400_000));
}

/** Half-open overlap: a block ending exactly when the next starts is not a conflict. */
export async function checkAvailability(
  db: Queryable,
  tenantId: string,
  vehicleId: string,
  startsAt: Date,
  endsAt: Date,
): Promise<AvailabilityResult> {
  if (endsAt <= startsAt) {
    return { vehicleId, available: false, authoritative: false, conflictCount: 0 };
  }
  const rules = await getRules(db, tenantId);
  const { rows } = await db.query(
    `SELECT count(*)::int AS n FROM vehicle_blocks
      WHERE tenant_id = $1 AND vehicle_id = $2
        AND starts_at < $4 AND ends_at > $3`,
    [tenantId, vehicleId, startsAt.toISOString(), endsAt.toISOString()],
  );
  const conflicts = rows[0]?.n ?? 0;
  return {
    vehicleId,
    available: conflicts === 0,
    authoritative: rules.inventoryAuthoritative,
    conflictCount: conflicts,
  };
}

export async function findAvailableVehicles(
  db: Queryable,
  tenantId: string,
  startsAt: Date,
  endsAt: Date,
  candidates?: Vehicle[],
): Promise<Array<Vehicle & { authoritative: boolean }>> {
  const list = candidates ?? (await listVehicles(db, tenantId));
  const rules = await getRules(db, tenantId);
  if (!list.length) return [];
  const ids = list.map((v) => v.id);
  const { rows } = await db.query(
    `SELECT DISTINCT vehicle_id FROM vehicle_blocks
      WHERE tenant_id = $1 AND vehicle_id = ANY($2::uuid[])
        AND starts_at < $4 AND ends_at > $3`,
    [tenantId, ids, startsAt.toISOString(), endsAt.toISOString()],
  );
  const blocked = new Set(rows.map((r: any) => r.vehicle_id));
  return list
    .filter((v) => !blocked.has(v.id))
    .map((v) => ({ ...v, authoritative: rules.inventoryAuthoritative }));
}

/**
 * Places a block. The unique-ish guard is a re-check inside the same transaction:
 * callers run this within withTenant, so the SELECT and INSERT share a transaction
 * and a concurrent hold on the same window loses on the second check.
 */
export async function placeBlock(
  db: Queryable,
  tenantId: string,
  input: {
    vehicleId: string;
    startsAt: Date;
    endsAt: Date;
    reason: "booking" | "hold" | "maintenance" | "external";
    source?: "kirmi" | "external_api" | "staff";
    referenceId?: string | null;
  },
): Promise<{ ok: true; id: string } | { ok: false; reason: "conflict" }> {
  const check = await checkAvailability(db, tenantId, input.vehicleId, input.startsAt, input.endsAt);
  if (!check.available) return { ok: false, reason: "conflict" };
  const { rows } = await db.query(
    `INSERT INTO vehicle_blocks (tenant_id, vehicle_id, starts_at, ends_at, reason, source, reference_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
    [
      tenantId,
      input.vehicleId,
      input.startsAt.toISOString(),
      input.endsAt.toISOString(),
      input.reason,
      input.source ?? "kirmi",
      input.referenceId ?? null,
    ],
  );
  return { ok: true, id: rows[0].id };
}

export async function releaseBlocksFor(db: Queryable, tenantId: string, referenceId: string): Promise<number> {
  const { rowCount } = await db.query(`DELETE FROM vehicle_blocks WHERE tenant_id=$1 AND reference_id=$2`, [
    tenantId,
    referenceId,
  ]);
  return rowCount ?? 0;
}

/** Expire holds whose reservation hold window has passed. Run by the scheduler. */
export async function releaseExpiredHolds(db: Queryable, tenantId: string, now = new Date()): Promise<number> {
  const { rowCount } = await db.query(
    `DELETE FROM vehicle_blocks vb
      USING reservations r
      WHERE vb.tenant_id = $1
        AND vb.reason = 'hold'
        AND vb.reference_id = r.id
        AND r.state IN ('held','documents_pending','payment_pending')
        AND r.hold_expires_at IS NOT NULL
        AND r.hold_expires_at < $2`,
    [tenantId, now.toISOString()],
  );
  return rowCount ?? 0;
}

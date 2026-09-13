import type { Queryable } from "../db/index.js";

/** How we know a value. Drives whether the engine may state it to a customer as fact. */
export type Provenance = "verified_public" | "client_provided" | "assumed";

export type SettingRecord<T = unknown> = { value: T; provenance: Provenance };

/**
 * Business rules live here as data, never in code. A rule whose provenance is
 * "assumed" is visible as such in the console so nobody mistakes our placeholder
 * for the client's actual policy.
 */
export type TenantRules = {
  minAge: number;
  depositDefault: number; // minor units
  vatPercent: number;
  deliveryFee: number; // minor units
  freeDeliveryThresholdDays: number | null;
  requiredDocuments: string[];
  paymentMethods: Array<"card" | "cash" | "crypto" | "bank_transfer">;
  weeklyThresholdDays: number;
  monthlyThresholdDays: number;
  holdMinutes: number;
  quoteValidHours: number;
  supportHours: string;
  maxDrivers: number;
  /** When false the engine must say availability is subject to confirmation. */
  inventoryAuthoritative: boolean;
};

export const DEFAULT_RULES: TenantRules = {
  minAge: 21,
  depositDefault: 0,
  vatPercent: 5,
  deliveryFee: 0,
  freeDeliveryThresholdDays: null,
  requiredDocuments: ["passport", "driving_licence"],
  paymentMethods: ["card"],
  weeklyThresholdDays: 7,
  monthlyThresholdDays: 28,
  holdMinutes: 120,
  quoteValidHours: 48,
  supportHours: "24/7",
  maxDrivers: 1,
  inventoryAuthoritative: false,
};

export async function getSetting<T>(db: Queryable, tenantId: string, key: string): Promise<SettingRecord<T> | null> {
  const { rows } = await db.query(`SELECT value, provenance FROM tenant_settings WHERE tenant_id=$1 AND key=$2`, [
    tenantId,
    key,
  ]);
  if (!rows[0]) return null;
  return { value: rows[0].value as T, provenance: rows[0].provenance as Provenance };
}

export async function setSetting(
  db: Queryable,
  tenantId: string,
  key: string,
  value: unknown,
  provenance: Provenance = "assumed",
): Promise<void> {
  await db.query(
    `INSERT INTO tenant_settings (tenant_id, key, value, provenance, updated_at)
     VALUES ($1,$2,$3,$4, now())
     ON CONFLICT (tenant_id, key) DO UPDATE
       SET value = EXCLUDED.value, provenance = EXCLUDED.provenance, updated_at = now()`,
    [tenantId, key, JSON.stringify(value), provenance],
  );
}

export async function getRules(db: Queryable, tenantId: string): Promise<TenantRules> {
  const rec = await getSetting<Partial<TenantRules>>(db, tenantId, "rules");
  return { ...DEFAULT_RULES, ...(rec?.value ?? {}) };
}

export async function listSettings(db: Queryable, tenantId: string): Promise<Record<string, SettingRecord>> {
  const { rows } = await db.query(`SELECT key, value, provenance FROM tenant_settings WHERE tenant_id=$1 ORDER BY key`, [
    tenantId,
  ]);
  const out: Record<string, SettingRecord> = {};
  for (const r of rows) out[r.key] = { value: r.value, provenance: r.provenance };
  return out;
}

import type { Queryable } from "../db/index.js";

export type Vehicle = {
  id: string;
  make: string;
  model: string;
  year: number | null;
  category: string;
  plate: string | null;
  dailyRate: number;
  weeklyRate: number | null;
  monthlyRate: number | null;
  deposit: number;
  dailyKm: number | null;
  extraKmRate: number | null;
  minAge: number | null;
  minDays: number;
  status: "active" | "maintenance" | "retired";
  attributes: Record<string, unknown>;
};

const SELECT = `id, make, model, year, category, plate, daily_rate, weekly_rate, monthly_rate,
                deposit, daily_km, extra_km_rate, min_age, min_days, status, attributes`;

function map(r: any): Vehicle {
  return {
    id: r.id,
    make: r.make,
    model: r.model,
    year: r.year,
    category: r.category,
    plate: r.plate,
    dailyRate: r.daily_rate,
    weeklyRate: r.weekly_rate,
    monthlyRate: r.monthly_rate,
    deposit: r.deposit,
    dailyKm: r.daily_km,
    extraKmRate: r.extra_km_rate,
    minAge: r.min_age,
    minDays: r.min_days,
    status: r.status,
    attributes: r.attributes ?? {},
  };
}

export async function listVehicles(db: Queryable, tenantId: string, opts: { includeInactive?: boolean } = {}): Promise<Vehicle[]> {
  const { rows } = await db.query(
    `SELECT ${SELECT} FROM vehicles
      WHERE tenant_id = $1 ${opts.includeInactive ? "" : "AND status = 'active'"}
      ORDER BY make, model`,
    [tenantId],
  );
  return rows.map(map);
}

export async function getVehicle(db: Queryable, tenantId: string, id: string): Promise<Vehicle | null> {
  const { rows } = await db.query(`SELECT ${SELECT} FROM vehicles WHERE tenant_id=$1 AND id=$2`, [tenantId, id]);
  return rows[0] ? map(rows[0]) : null;
}

export async function createVehicle(
  db: Queryable,
  tenantId: string,
  v: Omit<Vehicle, "id" | "status" | "attributes"> & { status?: Vehicle["status"]; attributes?: Record<string, unknown> },
): Promise<Vehicle> {
  const { rows } = await db.query(
    `INSERT INTO vehicles (tenant_id, make, model, year, category, plate, daily_rate, weekly_rate,
                           monthly_rate, deposit, daily_km, extra_km_rate, min_age, min_days, status, attributes)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING ${SELECT}`,
    [
      tenantId, v.make, v.model, v.year, v.category, v.plate, v.dailyRate, v.weeklyRate, v.monthlyRate,
      v.deposit, v.dailyKm, v.extraKmRate, v.minAge, v.minDays, v.status ?? "active",
      JSON.stringify(v.attributes ?? {}),
    ],
  );
  return map(rows[0]);
}

export async function updateVehicle(
  db: Queryable,
  tenantId: string,
  id: string,
  patch: Partial<Omit<Vehicle, "id">>,
): Promise<Vehicle | null> {
  const cols: Record<string, string> = {
    make: "make", model: "model", year: "year", category: "category", plate: "plate",
    dailyRate: "daily_rate", weeklyRate: "weekly_rate", monthlyRate: "monthly_rate",
    deposit: "deposit", dailyKm: "daily_km", extraKmRate: "extra_km_rate",
    minAge: "min_age", minDays: "min_days", status: "status",
  };
  const sets: string[] = [];
  const vals: unknown[] = [tenantId, id];
  for (const [k, col] of Object.entries(cols)) {
    if (k in patch) {
      vals.push((patch as any)[k]);
      sets.push(`${col} = $${vals.length}`);
    }
  }
  if (patch.attributes) {
    vals.push(JSON.stringify(patch.attributes));
    sets.push(`attributes = $${vals.length}`);
  }
  if (!sets.length) return getVehicle(db, tenantId, id);
  const { rows } = await db.query(
    `UPDATE vehicles SET ${sets.join(", ")} WHERE tenant_id=$1 AND id=$2 RETURNING ${SELECT}`,
    vals,
  );
  return rows[0] ? map(rows[0]) : null;
}

/**
 * Fuzzy fleet search over make/model/category. Used by the AI tool layer so a
 * customer asking for "the G63" or "a convertible" resolves to real rows rather
 * than the model inventing a car.
 */
export async function searchVehicles(db: Queryable, tenantId: string, term: string, limit = 5): Promise<Vehicle[]> {
  const cleaned = term.trim().toLowerCase().replace(/[^a-z0-9\s-]/g, " ").replace(/\s+/g, " ");
  if (!cleaned) return [];
  const tokens = cleaned.split(" ").filter((t) => t.length >= 2);
  if (!tokens.length) return [];
  const conds: string[] = [];
  const vals: unknown[] = [tenantId];
  for (const t of tokens) {
    vals.push(`%${t}%`);
    const i = vals.length;
    conds.push(`(lower(make) LIKE $${i} OR lower(model) LIKE $${i} OR lower(category) LIKE $${i}
                 OR lower(make || ' ' || model) LIKE $${i})`);
  }
  vals.push(limit);
  const { rows } = await db.query(
    `SELECT ${SELECT},
            (${tokens.map((_, i) => `(CASE WHEN lower(make || ' ' || model) LIKE $${i + 2} THEN 1 ELSE 0 END)`).join(" + ")}) AS score
       FROM vehicles
      WHERE tenant_id = $1 AND status = 'active' AND (${conds.join(" OR ")})
      ORDER BY score DESC, make, model
      LIMIT $${vals.length}`,
    vals,
  );
  return rows.map(map);
}

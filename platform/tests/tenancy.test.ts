import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { resetDb, createTenant, asTenant } from "./helpers.js";
import { closePool, withAdmin } from "../src/db/index.js";
import { createVehicle, listVehicles, getVehicle } from "../src/domain/vehicles.js";

describe("tenant isolation (Postgres RLS)", () => {
  let a: string;
  let b: string;

  beforeAll(async () => {
    await resetDb();
    a = await createTenant({ slug: "iso-a" });
    b = await createTenant({ slug: "iso-b" });
    await asTenant(a, (db) =>
      createVehicle(db, a, {
        make: "Mercedes", model: "G63", year: 2024, category: "suv", plate: "A-1",
        dailyRate: 250000, weeklyRate: null, monthlyRate: null, deposit: 500000,
        dailyKm: 250, extraKmRate: 300, minAge: 25, minDays: 1,
      }),
    );
    await asTenant(b, (db) =>
      createVehicle(db, b, {
        make: "Nissan", model: "Patrol", year: 2023, category: "suv", plate: "B-1",
        dailyRate: 90000, weeklyRate: null, monthlyRate: null, deposit: 200000,
        dailyKm: 250, extraKmRate: 200, minAge: 21, minDays: 1,
      }),
    );
  });

  afterAll(async () => { await closePool(); });

  it("each tenant sees only its own fleet", async () => {
    const av = await asTenant(a, (db) => listVehicles(db, a));
    const bv = await asTenant(b, (db) => listVehicles(db, b));
    expect(av.map((v) => v.model)).toEqual(["G63"]);
    expect(bv.map((v) => v.model)).toEqual(["Patrol"]);
  });

  it("a query that names another tenant's id still returns nothing", async () => {
    // The WHERE clause asks for tenant B's rows while the session is pinned to A.
    // RLS, not the application, is what makes this empty.
    const leaked = await asTenant(a, (db) => listVehicles(db, b));
    expect(leaked).toEqual([]);
  });

  it("fetching another tenant's row by primary key returns null", async () => {
    const bVehicle = (await asTenant(b, (db) => listVehicles(db, b)))[0]!;
    const stolen = await asTenant(a, (db) => getVehicle(db, a, bVehicle.id));
    expect(stolen).toBeNull();
    // even when the caller passes B's tenant id explicitly
    const stolen2 = await asTenant(a, (db) => getVehicle(db, b, bVehicle.id));
    expect(stolen2).toBeNull();
  });

  it("writing a row tagged with another tenant is rejected by the policy", async () => {
    await expect(
      asTenant(a, (db) =>
        db.query(
          `INSERT INTO vehicles (tenant_id, make, model, category, daily_rate, deposit, min_days)
           VALUES ($1,'X','Y','standard',1000,0,1)`,
          [b],
        ),
      ),
    ).rejects.toThrow(/row-level security/i);
  });

  it("the tenant setting does not leak to the next user of the pooled connection", async () => {
    await asTenant(a, async () => undefined);
    // A bare admin read sees both tenants; if app.tenant_id had leaked it would see one.
    const all = await withAdmin(async (db) => {
      const { rows } = await db.query(`SELECT tenant_id FROM vehicles`);
      return rows;
    });
    expect(new Set(all.map((r: any) => r.tenant_id)).size).toBe(2);
  });

  it("audit entries are written per tenant", async () => {
    const rows = await withAdmin(async (db) => {
      const { rows } = await db.query(
        `SELECT tenant_id, action FROM audit_log WHERE action = 'integration.state_changed'`,
      );
      return rows;
    });
    expect(rows.length).toBeGreaterThanOrEqual(12);
  });
});

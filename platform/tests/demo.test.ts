import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { resetDb, createTenant } from "./helpers.js";
import { closePool, query, withTenant } from "../src/db/index.js";
import { seedDemoTenant, runJourney, DEMO_SLUG } from "../src/api/demo.js";
import type { FastifyInstance } from "fastify";

describe("demo mode isolation", () => {
  let app: FastifyInstance;
  let demoId: string;
  let prodId: string;

  beforeAll(async () => {
    await resetDb();
    prodId = await createTenant({ slug: "deiz", name: "DEIZ Rental Dubai", mode: "production" });
    const { buildServer } = await import("../src/server.js");
    app = await buildServer();
    await app.ready();
    demoId = await seedDemoTenant();
  });

  afterAll(async () => { await app.close(); await closePool(); });

  it("creates the demo tenant in demo mode, separate from production", async () => {
    const { rows } = await query(`SELECT slug, mode FROM tenants ORDER BY slug`);
    expect(rows).toEqual([
      { slug: "deiz", mode: "production" },
      { slug: DEMO_SLUG, mode: "demo" },
    ]);
    expect(demoId).not.toBe(prodId);
  });

  it("runs the whole journey through real domain logic", async () => {
    const steps = await runJourney(demoId, "DEIZ Rental");
    const keys = steps.map((s) => s.key);
    for (const required of [
      "enquiry", "instant_reply", "qualify", "availability", "quote", "reservation",
      "documents", "doc_review", "payment_link", "confirmed", "instagram",
      "followup_scheduled", "followup_sent", "recovery", "escalation", "takeover",
    ]) {
      expect(keys).toContain(required);
    }
    // the quote came from the real pricing engine, not a string
    const quote = steps.find((s) => s.key === "quote")!;
    expect(quote.detail).toMatch(/AED/);
    expect(quote.data?.total).toMatch(/AED/);
    // the booking really reached confirmed via an authoritative source
    expect(steps.find((s) => s.key === "confirmed")!.detail).toMatch(/staff/);
  });

  it("leaves production data completely untouched", async () => {
    const prod = await withTenant(prodId, async (db) => {
      const { rows } = await db.query(
        `SELECT
           (SELECT count(*)::int FROM conversations) AS conversations,
           (SELECT count(*)::int FROM messages) AS messages,
           (SELECT count(*)::int FROM reservations) AS reservations,
           (SELECT count(*)::int FROM payments) AS payments,
           (SELECT count(*)::int FROM outbox) AS outbox`,
      );
      return rows[0];
    });
    expect(prod).toEqual({ conversations: 0, messages: 0, reservations: 0, payments: 0, outbox: 0 });
  });

  it("refuses to run demo actions against a production tenant", async () => {
    // rename production to the demo slug: the mode guard, not the slug, must stop it
    await query(`UPDATE tenants SET slug='demo-impostor' WHERE slug=$1`, [DEMO_SLUG]);
    await query(`UPDATE tenants SET slug=$1 WHERE slug='deiz'`, [DEMO_SLUG]);

    const res = await app.inject({ method: "GET", url: "/api/demo/state" });
    expect(res.statusCode).toBe(403);
    expect(res.json().message).toMatch(/non-demo/i);

    // restore
    await query(`UPDATE tenants SET slug='deiz' WHERE slug=$1`, [DEMO_SLUG]);
    await query(`UPDATE tenants SET slug=$1 WHERE slug='demo-impostor'`, [DEMO_SLUG]);
  });

  it("never sends through a real provider: demo payments are staff-confirmed mocks", async () => {
    const rows = await withTenant(demoId, async (db) => {
      const { rows } = await db.query(`SELECT provider, status, method FROM payments WHERE tenant_id=$1`, [demoId]);
      return rows;
    });
    expect(rows.length).toBeGreaterThan(0);
    for (const p of rows) {
      expect(p.provider === null || p.provider === "mock").toBe(true);
      expect(p.status).not.toBe("paid");
    }
  });

  it("serves the demo page and the live sandbox endpoint", async () => {
    const page = await app.inject({ method: "GET", url: "/demo" });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain("Demonstration environment");

    const msg = await app.inject({
      method: "POST", url: "/api/demo/message",
      payload: { text: "how much for the Patrol tomorrow for 2 days" },
    });
    expect(msg.statusCode).toBe(200);
    expect(msg.json().reply).toMatch(/Patrol/);
  });
});

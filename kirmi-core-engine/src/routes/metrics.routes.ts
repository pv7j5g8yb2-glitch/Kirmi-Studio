import { Router, type Request, type Response } from "express";
import { z } from "zod";
import type { Container } from "../core/container.js";
import { toMajor } from "../core/money.js";
import { ValidationError } from "../core/errors.js";
import { requireClientApiKey } from "../middleware/dashboard-auth.middleware.js";
import { rateLimit } from "../middleware/rate-limit.js";

/**
 * ===========================================================================
 * THE METRICS API
 * ===========================================================================
 *
 * Four channels, shaped for a React or Next.js dashboard to render without
 * doing any arithmetic of its own:
 *
 *   1. Enquiries received
 *   2. Bookings secured
 *   3. Total tracked revenue
 *   4. Kirmi B2B fee generated
 *
 * Every amount is returned twice, as an integer count of minor units and as a
 * major unit decimal. The integer is the truth; the decimal is there so a
 * front end never has to divide by 100 and never has a reason to introduce a
 * float into a figure a client will read.
 */
const windowSchema = z.object({
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
  /** Convenience: last N days, when a caller does not want to build dates. */
  days: z.coerce.number().int().min(1).max(365).optional(),
});

export function metricsRoutes(container: Container): Router {
  const router = Router();

  router.use(
    requireClientApiKey(container.db, container.config, "metrics:read"),
    rateLimit({ bucket: "metrics", limit: 120, windowSeconds: 60 }),
  );

  /** All four headline channels in one call: one request per dashboard load. */
  router.get("/summary", (req: Request, res: Response) => {
    void (async () => {
      const tenant = req.tenant;
      if (!tenant) throw new ValidationError("Tenant not resolved");

      const window = parseWindow(req);
      const snapshot = await container.metrics.snapshot(tenant, window);

      res.json({
        window: snapshot.window,
        currency: snapshot.currency,
        // So the client's own results page can title itself without a second
        // call just to learn whose data it is showing.
        tradingName: tenant.tradingName,
        timezone: tenant.timezone,
        channels: {
          enquiriesReceived: { value: snapshot.enquiriesReceived, label: "Enquiries received" },
          bookingsSecured: { value: snapshot.bookingsSecured, label: "Bookings secured" },
          revenueTracked: {
            minor: snapshot.revenue.netMinor,
            major: toMajor(snapshot.revenue.netMinor),
            grossMinor: snapshot.revenue.grossMinor,
            cancelledMinor: snapshot.revenue.cancelledMinor,
            label: "Total tracked revenue",
          },
          kirmiFeeGenerated: {
            minor: snapshot.kirmiFee.totalMinor,
            major: toMajor(snapshot.kirmiFee.totalMinor),
            commissionMinor: snapshot.kirmiFee.commissionMinor,
            retainerMinor: snapshot.kirmiFee.retainerMinor,
            feeModel: snapshot.kirmiFee.feeModel,
            label: "Kirmi fee generated",
          },
        },
        // The two figures that answer "what are we paying you for". A client
        // reading "13 bookings" assumes they would have had those anyway;
        // these say which ones nobody was going to answer at all.
        attributableToUs: {
          outOfHoursEnquiries: snapshot.attributableToUs.outOfHoursEnquiries,
          outOfHoursSharePercent: snapshot.attributableToUs.outOfHoursSharePercent,
          bookingsRecoveredByFollowUp: snapshot.attributableToUs.bookingsRecoveredByFollowUp,
          recoveredRevenue: {
            minor: snapshot.attributableToUs.recoveredRevenueMinor,
            major: toMajor(snapshot.attributableToUs.recoveredRevenueMinor),
          },
        },
        context: snapshot.context,
      });
    })().catch((err: unknown) => {
      req.log?.error({ err }, "metrics summary failed");
      res.status(500).json({ error: { code: "METRICS_FAILED" } });
    });
  });

  /** Daily buckets, in the client's own timezone, for the dashboard chart. */
  router.get("/daily", (req: Request, res: Response) => {
    void (async () => {
      const tenant = req.tenant;
      if (!tenant) throw new ValidationError("Tenant not resolved");

      const points = await container.metrics.daily(tenant, parseWindow(req));
      res.json({
        currency: tenant.currency,
        timezone: tenant.timezone,
        points: points.map((p) => ({ ...p, revenueMajor: toMajor(p.revenueMinor) })),
      });
    })().catch((err: unknown) => {
      req.log?.error({ err }, "metrics daily failed");
      res.status(500).json({ error: { code: "METRICS_FAILED" } });
    });
  });

  return router;
}

/**
 * Defaults to the last 30 days. An unbounded query over the ledger is a table
 * scan, and a dashboard that quietly asks for all time on every load is how a
 * database falls over at the end of a busy quarter.
 */
function parseWindow(req: Request): { from: Date; to: Date } {
  const parsed = windowSchema.safeParse(req.query);
  if (!parsed.success) {
    throw new ValidationError("Invalid date window", { issues: parsed.error.issues.map((i) => i.message) });
  }

  const to = parsed.data.to ? new Date(parsed.data.to) : new Date();
  const days = parsed.data.days ?? 30;
  const from = parsed.data.from ? new Date(parsed.data.from) : new Date(to.getTime() - days * 24 * 3_600_000);

  if (from.getTime() >= to.getTime()) throw new ValidationError("`from` must be before `to`");
  return { from, to };
}

import { Router, type Request, type Response } from "express";
import { z } from "zod";
import type { Container } from "../core/container.js";
import { ValidationError } from "../core/errors.js";
import { toMajor } from "../core/money.js";
import { asyncHandler } from "../middleware/async-handler.js";
import { requireClientApiKey } from "../middleware/dashboard-auth.middleware.js";
import { rateLimit } from "../middleware/rate-limit.js";
import { renderReport } from "../services/attribution.service.js";

/**
 * ===========================================================================
 * THE COMMISSION REPORT
 * ===========================================================================
 *
 * The document that turns a month of conversations into an invoice.
 *
 * Exposed to the client under their own API key, not kept behind Kirmi's back
 * office, and that is a commercial decision rather than a technical one. A
 * commission agreement where only one side can see the workings is a monthly
 * argument. One where the client can pull the same line by line report at any
 * time, including the bookings that were NOT counted and why, is a partnership
 * that survives its first disputed figure.
 */
const periodSchema = z.object({
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
  days: z.coerce.number().int().min(1).max(365).optional(),
});

export function attributionRoutes(container: Container): Router {
  const router = Router();

  router.use(
    requireClientApiKey(container.db, container.config, "metrics:read"),
    rateLimit({ bucket: "attribution", limit: 60, windowSeconds: 60 }),
  );

  router.get(
    "/report",
    asyncHandler(async (req: Request, res: Response) => {
      const tenant = req.tenant;
      if (!tenant) throw new ValidationError("Tenant not resolved");

      const { from, to } = parsePeriod(req);
      const report = await container.attribution.report(
        tenant.clientId,
        from,
        to,
        tenant.billing.commissionBasisPoints,
        tenant.currency,
      );

      // Text on request, because the thing that actually gets sent with an
      // invoice is a readable list, not a JSON payload.
      if (req.query["format"] === "text") {
        res.type("text/plain").send(renderReport(report, tenant.tradingName));
        return;
      }

      res.json({
        window: { from: report.from.toISOString(), to: report.to.toISOString() },
        currency: report.totals.currency,
        totals: {
          bookings: report.totals.bookingCount,
          rentalValue: {
            minor: report.totals.rentalValueMinor,
            major: toMajor(report.totals.rentalValueMinor),
          },
          commission: {
            minor: report.totals.commissionMinor,
            major: toMajor(report.totals.commissionMinor),
            basisPoints: report.totals.commissionBasisPoints,
          },
        },
        bookings: report.bookings.map((b) => ({
          reference: b.reference,
          status: b.status,
          vehicle: b.vehicle,
          plateNumber: b.plateNumber,
          startAt: b.startAt.toISOString(),
          endAt: b.endAt.toISOString(),
          durationDays: b.durationDays,
          rentalValue: { minor: b.rentalValueMinor, major: toMajor(b.rentalValueMinor) },
          channel: b.channel,
          quotedAt: b.quotedAt?.toISOString() ?? null,
          confirmedAt: b.confirmedAt?.toISOString() ?? null,
          humanJoinedAt: b.humanJoinedAt?.toISOString() ?? null,
        })),
        excluded: report.excluded,
      });
    }),
  );

  return router;
}

/** Defaults to the last 30 days, which is the pilot's own invoice period. */
function parsePeriod(req: Request): { from: Date; to: Date } {
  const parsed = periodSchema.safeParse(req.query);
  if (!parsed.success) throw new ValidationError("Invalid reporting period");

  const to = parsed.data.to ? new Date(parsed.data.to) : new Date();
  if (parsed.data.from) return { from: new Date(parsed.data.from), to };

  const days = parsed.data.days ?? 30;
  return { from: new Date(to.getTime() - days * 24 * 60 * 60 * 1000), to };
}

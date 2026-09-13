import { Router, type Request, type Response } from "express";
import { redis } from "../cache/redis.js";
import { prisma } from "../db/prisma.js";

/**
 * Liveness and readiness.
 *
 * Separate endpoints because they answer different questions and a load
 * balancer should treat them differently. Liveness asks whether this process is
 * wedged and should be restarted. Readiness asks whether it can serve traffic
 * right now, which it cannot without Postgres and Redis.
 *
 * Conflating them is how a brief database blip turns into a rolling restart of
 * every healthy node in the fleet.
 */
export function healthRoutes(): Router {
  const router = Router();

  router.get("/live", (_req: Request, res: Response) => {
    res.json({ status: "ok", uptimeSeconds: Math.round(process.uptime()) });
  });

  router.get("/ready", (_req: Request, res: Response) => {
    void (async () => {
      const checks: Record<string, "ok" | "failed"> = {};

      try {
        await prisma().$queryRaw`SELECT 1`;
        checks["postgres"] = "ok";
      } catch {
        checks["postgres"] = "failed";
      }

      try {
        await redis().ping();
        checks["redis"] = "ok";
      } catch {
        checks["redis"] = "failed";
      }

      const ready = Object.values(checks).every((c) => c === "ok");
      res.status(ready ? 200 : 503).json({ status: ready ? "ready" : "degraded", checks });
    })();
  });

  return router;
}

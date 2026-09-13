import type { NextFunction, Request, RequestHandler, Response } from "express";
import type { Redis } from "ioredis";
import { REDIS_NAMESPACE } from "../config/constants.js";
import { RateLimitedError } from "../core/errors.js";
import { redis } from "../cache/redis.js";

/**
 * A fixed window limiter, per tenant, per bucket.
 *
 * Deliberately not applied to carrier webhooks. Rate limiting Meta means
 * dropping real customer messages during exactly the burst a rental desk most
 * wants to capture, and Meta responds to a 429 by retrying anyway. The
 * protection that belongs on that path is the idempotency guard, not a limiter.
 *
 * This is for the dashboard and metrics API, where a runaway client script is a
 * real risk and a 429 is a correct answer.
 */
export function rateLimit(options: { bucket: string; limit: number; windowSeconds: number; client?: Redis }): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    void (async () => {
      try {
        const client = options.client ?? redis();
        const identity = req.routing?.clientId ?? req.ip ?? "anonymous";
        const window = Math.floor(Date.now() / 1000 / options.windowSeconds);
        const key = `${REDIS_NAMESPACE.rateLimit}:${options.bucket}:${identity}:${window}`;

        const count = await client.incr(key);
        if (count === 1) await client.expire(key, options.windowSeconds);

        res.setHeader("x-ratelimit-limit", options.limit);
        res.setHeader("x-ratelimit-remaining", Math.max(0, options.limit - count));

        if (count > options.limit) {
          throw new RateLimitedError("Too many requests", { limit: options.limit, windowSeconds: options.windowSeconds });
        }
        next();
      } catch (err) {
        // A Redis outage must not close the dashboard. Fail open here, because
        // the thing being protected against is accidental load, not an attack.
        if (err instanceof RateLimitedError) {
          next(err);
          return;
        }
        req.log?.warn({ err }, "rate limiter unavailable, allowing request");
        next();
      }
    })();
  };
}

import { randomUUID } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { scopedLogger } from "../core/logger.js";

/**
 * Request identity and a bound logger.
 *
 * An inbound WhatsApp message touches a route, a queue, a worker, an LLM call
 * and three services. Without one id threading through all of it, debugging a
 * single customer's bad experience means reading everything that happened in
 * that minute for every tenant at once.
 */
export function requestContext() {
  return (req: Request, res: Response, next: NextFunction): void => {
    // Honour an upstream id if the proxy set one, so traces join up.
    const header = req.get("x-request-id");
    const requestId = header && header.length <= 128 ? header : randomUUID();

    req.requestId = requestId;
    req.log = scopedLogger({ requestId, method: req.method, path: req.path });
    res.setHeader("x-request-id", requestId);

    next();
  };
}

/** Capture the exact bytes received, for signature verification. */
export function captureRawBody(req: Request, _res: Response, buf: Buffer): void {
  if (buf.length > 0) req.rawBody = Buffer.from(buf);
}

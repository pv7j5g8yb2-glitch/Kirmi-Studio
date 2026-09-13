import type { NextFunction, Request, RequestHandler, Response } from "express";

/**
 * Route an async handler's rejection into Express's error pipeline.
 *
 * Express 4 does not await handlers, so a rejected promise inside one is an
 * unhandled rejection and, worse, a request that never receives a response. On
 * a webhook endpoint that is not a 500, it is a socket held open until the
 * carrier times out and redelivers, which turns one transient failure into a
 * retry storm.
 *
 * Every async route in this service is wrapped in this, so a throw becomes a
 * response.
 */
export function asyncHandler(
  handler: (req: Request, res: Response, next: NextFunction) => Promise<unknown>,
): RequestHandler {
  return (req, res, next) => {
    void handler(req, res, next).catch(next);
  };
}

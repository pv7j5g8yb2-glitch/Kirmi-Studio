import type { NextFunction, Request, Response } from "express";
import { isAppError } from "../core/errors.js";
import { logger } from "../core/logger.js";

/** 404 for anything that fell through the router. */
export function notFoundHandler() {
  return (_req: Request, res: Response): void => {
    res.status(404).json({ error: { code: "NOT_FOUND", message: "No such route" } });
  };
}

/**
 * The single exit point for every error.
 *
 * Two rules. Known errors report their own code and status. Unknown errors
 * report a generic 500 and nothing else, because an unexpected exception's
 * message is as likely to contain a connection string or a row of customer data
 * as it is to be useful, and the caller is not always someone we trust.
 *
 * The full detail always reaches the logs. It just never reaches the wire.
 */
export function errorHandler() {
  return (err: unknown, req: Request, res: Response, next: NextFunction): void => {
    if (res.headersSent) {
      next(err);
      return;
    }

    const log = req.log ?? logger();

    if (isAppError(err)) {
      // Client errors are noise at error level; server errors are not.
      const level = err.httpStatus >= 500 ? "error" : "warn";
      log[level]({ err, code: err.code, details: err.details }, "request failed");
      res.status(err.httpStatus).json({ error: err.toJSON() });
      return;
    }

    log.error({ err }, "unhandled error");
    res.status(500).json({ error: { code: "INTERNAL_ERROR", message: "Request could not be completed" } });
  };
}

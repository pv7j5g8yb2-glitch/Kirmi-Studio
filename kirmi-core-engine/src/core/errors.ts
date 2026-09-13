/**
 * The engine's error vocabulary.
 *
 * Every error carries a stable machine code and an HTTP status, because these
 * errors are read by three different audiences: an operator reading logs, a
 * carrier deciding whether to retry a webhook, and a dashboard deciding what to
 * show a human. `expose` marks the errors whose message is safe to hand back
 * over the wire. Everything else is logged in full and reported as a generic
 * failure, so an internal detail never rides out in a response body.
 */
export abstract class AppError extends Error {
  abstract readonly code: string;
  abstract readonly httpStatus: number;
  /** Whether `message` may be shown to the caller. Defaults to false. */
  readonly expose: boolean = false;
  readonly details: Record<string, unknown>;

  constructor(message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = new.target.name;
    this.details = details;
    Error.captureStackTrace?.(this, new.target);
  }

  toJSON(): Record<string, unknown> {
    return { code: this.code, message: this.expose ? this.message : "Request could not be completed", ...this.details };
  }
}

export class ValidationError extends AppError {
  readonly code = "VALIDATION_FAILED";
  readonly httpStatus = 400;
  override readonly expose = true;
}

export class NotFoundError extends AppError {
  readonly code = "NOT_FOUND";
  readonly httpStatus = 404;
  override readonly expose = true;
}

/** The clientId on the request does not resolve to an active tenant. */
export class TenantResolutionError extends AppError {
  readonly code = "TENANT_NOT_RESOLVED";
  readonly httpStatus = 404;
  override readonly expose = false;
}

/**
 * A tenant scoped operation was attempted with no tenant in scope. This is
 * always a programming error, never a user error: it means something reached
 * the database without going through the isolation middleware.
 */
export class TenantScopeError extends AppError {
  readonly code = "TENANT_SCOPE_MISSING";
  readonly httpStatus = 500;
}

/** Signature verification failed. The body is not from who it claims to be. */
export class SignatureVerificationError extends AppError {
  readonly code = "SIGNATURE_INVALID";
  readonly httpStatus = 401;
}

/** A duplicate delivery. Not an error condition, but it short circuits the pipeline. */
export class DuplicateEventError extends AppError {
  readonly code = "DUPLICATE_EVENT";
  readonly httpStatus = 200;
}

/** The vehicle is real but not sellable for the requested window. */
export class VehicleUnavailableError extends AppError {
  readonly code = "VEHICLE_UNAVAILABLE";
  readonly httpStatus = 409;
  override readonly expose = true;
}

/**
 * Someone else holds the row lock on this vehicle right now. Distinct from
 * VEHICLE_UNAVAILABLE on purpose: unavailable is a settled fact, contended is a
 * race we lost by milliseconds, and the caller may reasonably retry.
 */
export class VehicleContendedError extends AppError {
  readonly code = "VEHICLE_CONTENDED";
  readonly httpStatus = 409;
  override readonly expose = true;
}

/** The conversation is in human hands. Automated writers must stand down. */
export class AiDisabledError extends AppError {
  readonly code = "AI_DISABLED";
  readonly httpStatus = 409;
}

/** A client row is present but its configuration is malformed or incomplete. */
export class ConfigurationError extends AppError {
  readonly code = "CLIENT_MISCONFIGURED";
  readonly httpStatus = 500;
}

/** Pricing was asked for something it cannot compute. Never guessed around. */
export class PricingError extends AppError {
  readonly code = "PRICING_FAILED";
  readonly httpStatus = 422;
  override readonly expose = true;
}

export class UnauthorisedError extends AppError {
  readonly code = "UNAUTHORISED";
  readonly httpStatus = 401;
}

export class RateLimitedError extends AppError {
  readonly code = "RATE_LIMITED";
  readonly httpStatus = 429;
  override readonly expose = true;
}

export function isAppError(err: unknown): err is AppError {
  return err instanceof AppError;
}

/**
 * Pull the Postgres SQLSTATE out of whatever the driver threw.
 *
 * Prisma does not surface it in one place. A raw query failure arrives as a
 * PrismaClientKnownRequestError whose own `code` is Prisma's P2010, with the
 * real SQLSTATE tucked into `meta.code`. Checking `code` first therefore finds
 * "P2010" and never sees the 55P03 underneath, which silently turns a handled
 * lock contention into an unhandled 500.
 *
 * So: meta.code first, then a plain driver code, then the message as a last
 * resort for driver versions that only render it there.
 */
export function pgErrorCode(err: unknown): string | undefined {
  if (typeof err !== "object" || err === null) return undefined;
  const candidate = err as { code?: unknown; meta?: { code?: unknown }; message?: unknown };

  if (candidate.meta && typeof candidate.meta.code === "string") return candidate.meta.code;

  // A bare SQLSTATE is five alphanumerics; Prisma's own codes start with P.
  if (typeof candidate.code === "string" && !/^P\d/.test(candidate.code)) return candidate.code;

  if (typeof candidate.message === "string") {
    const match = /Code:\s*`?([0-9A-Z]{5})`?/.exec(candidate.message);
    if (match?.[1]) return match[1];
  }

  return undefined;
}

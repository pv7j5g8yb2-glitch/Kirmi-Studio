export class AppError extends Error {
  constructor(
    message: string,
    readonly status = 400,
    readonly code = "bad_request",
    readonly detail?: unknown,
  ) {
    super(message);
    this.name = "AppError";
  }
}

export const badRequest = (m: string, d?: unknown) => new AppError(m, 400, "bad_request", d);
export const unauthorized = (m = "Authentication required") => new AppError(m, 401, "unauthorized");
export const forbidden = (m = "Not permitted") => new AppError(m, 403, "forbidden");
export const notFound = (m = "Not found") => new AppError(m, 404, "not_found");
export const conflict = (m: string, d?: unknown) => new AppError(m, 409, "conflict", d);

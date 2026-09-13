import type { Logger } from "pino";
import type { TenantProfile } from "../core/types.js";
import type { TenantRouting } from "../services/client-config.service.js";

/**
 * Request augmentation.
 *
 * Everything attached here is set by middleware and is therefore optional at
 * the type level, which is deliberate: a handler that reads req.tenant without
 * the isolation middleware in front of it should not typecheck.
 */
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** The exact bytes as received. Signature verification depends on them. */
      rawBody?: Buffer;
      requestId?: string;
      /** Set by tenant resolution, before the full profile is loaded. */
      routing?: TenantRouting;
      /** Set by tenant isolation once the profile is loaded and cached. */
      tenant?: TenantProfile;
      log?: Logger;
    }
  }
}

export {};

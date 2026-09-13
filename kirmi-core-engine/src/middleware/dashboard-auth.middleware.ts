import type { NextFunction, Request, RequestHandler, Response } from "express";
import { parseApiKey, safeEqual } from "../core/crypto.js";
import { UnauthorisedError } from "../core/errors.js";
import { runInTenantScope, type TenantDatabase } from "../db/tenant-context.js";
import type { ClientConfigService } from "../services/client-config.service.js";

/**
 * Dashboard and human inbox authentication.
 *
 * The flow exists in this shape because client_api_keys is under row level
 * security like every other tenant table, so a key cannot be looked up until a
 * tenant is already in scope. Resolving that chicken and egg by exempting the
 * key table from isolation would put a globally readable table of credentials
 * next to the data it protects.
 *
 * Instead the key carries its tenant in the clear (kirmi_<slug>.<secret>). The
 * slug routes; the secret authenticates, hashed and compared in constant time,
 * inside that tenant's own scope. A forged slug gets you as far as a scope
 * whose keys you still cannot match.
 */
export function requireClientApiKey(
  db: TenantDatabase,
  configService: ClientConfigService,
  requiredScope?: string,
): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction): void => {
    void (async () => {
      try {
        const header = req.get("authorization");
        const raw = header?.startsWith("Bearer ") ? header.slice(7) : req.get("x-api-key");
        if (!raw) throw new UnauthorisedError("Missing API key");

        const parsed = parseApiKey(raw);
        if (!parsed) throw new UnauthorisedError("Malformed API key");

        const routing = await configService.resolveRouting({ kind: "slug", value: parsed.slug });

        const key = await db.withTenant(routing.clientId, async (tx) =>
          tx.clientApiKey.findFirst({ where: { keyPrefix: parsed.prefix, revokedAt: null } }),
        );

        // Constant time, and the same failure whether the key is unknown or
        // simply wrong: a caller must not be able to tell those apart.
        if (!key || !safeEqual(key.keyHash, parsed.hash)) {
          throw new UnauthorisedError("Invalid API key");
        }

        if (requiredScope && !key.scopes.includes(requiredScope)) {
          throw new UnauthorisedError("API key lacks the required scope");
        }

        req.routing = routing;
        req.tenant = await configService.loadProfile(routing.clientId);
        const childLog = req.log?.child({ clientId: routing.clientId, apiKeyId: key.id });
        if (childLog) req.log = childLog;

        // Last used is best effort: a failed bookkeeping write must not fail an
        // otherwise valid request.
        void db
          .withTenant(routing.clientId, async (tx) =>
            tx.clientApiKey.update({ where: { id: key.id }, data: { lastUsedAt: new Date() } }),
          )
          .catch(() => undefined);

        runInTenantScope({ clientId: routing.clientId, ...(req.requestId ? { requestId: req.requestId } : {}) }, () => {
          next();
        });
      } catch (err) {
        next(err);
      }
    })();
  };
}

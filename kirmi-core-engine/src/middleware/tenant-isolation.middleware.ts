import type { NextFunction, Request, RequestHandler, Response } from "express";
import { TenantResolutionError } from "../core/errors.js";
import { runInTenantScope } from "../db/tenant-context.js";
import type { ClientConfigService, RoutingKey } from "../services/client-config.service.js";

/**
 * ===========================================================================
 * TENANT ISOLATION MIDDLEWARE
 * ===========================================================================
 *
 * The gate every tenant scoped request passes through. It does three things
 * and then gets out of the way:
 *
 *   1. Works out which client this request is for, from the route, the carrier
 *      payload or an API key.
 *   2. Loads that client's profile (cached, so this is usually one Redis GET).
 *   3. Opens an AsyncLocalStorage scope for the rest of the request, so every
 *      database call underneath runs with app.current_client_id set to this
 *      client and row level security confined to it.
 *
 * Step 3 is what makes the guarantee hold without discipline. A handler does
 * not pass a clientId down through four layers and hope nobody drops it. It is
 * ambient, it is set once here, and the database enforces it from below.
 *
 * The scope wraps `next()`, so it covers the entire downstream chain including
 * asynchronous work, and unwinds when the request finishes.
 */
export function resolveTenant(
  configService: ClientConfigService,
  extract: (req: Request) => RoutingKey | null,
): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const key = extract(req);
    if (!key) {
      next(new TenantResolutionError("Request carries no tenant routing key"));
      return;
    }

    void (async () => {
      try {
        const routing = await configService.resolveRouting(key);
        req.routing = routing;

        const tenant = await configService.loadProfile(routing.clientId);
        req.tenant = tenant;
        // exactOptionalPropertyTypes: only assign when there is something to assign.
        const childLog = req.log?.child({ clientId: routing.clientId, clientSlug: routing.slug });
        if (childLog) req.log = childLog;

        // Everything downstream now runs inside this tenant's scope.
        runInTenantScope({ clientId: routing.clientId, ...(req.requestId ? { requestId: req.requestId } : {}) }, () => {
          next();
        });
      } catch (err) {
        next(err);
      }
    })();
  };
}

/** Routing key from a :clientSlug path parameter. */
export const slugFromPath = (req: Request): RoutingKey | null => {
  const slug = req.params["clientSlug"];
  return slug ? { kind: "slug", value: slug } : null;
};

/**
 * Routing key from a Meta webhook body.
 *
 * Meta addresses WhatsApp by phone_number_id and Instagram by the recipient
 * page id. Both are read from the payload rather than the URL, so one endpoint
 * serves every tenant and onboarding a client does not mean deploying a route.
 */
export const routingFromMetaPayload = (req: Request): RoutingKey | null => {
  const body = req.body as MetaWebhookBody | undefined;
  const entry = body?.entry?.[0];

  const phoneNumberId = entry?.changes?.[0]?.value?.metadata?.phone_number_id;
  if (phoneNumberId) return { kind: "metaPhoneNumberId", value: phoneNumberId };

  const instagramRecipient = entry?.messaging?.[0]?.recipient?.id ?? entry?.id;
  if (instagramRecipient) return { kind: "instagramPageId", value: instagramRecipient };

  return null;
};

/** Routing key from a Twilio form post: the number that was called. */
export const routingFromTwilioPayload = (req: Request): RoutingKey | null => {
  const body = req.body as Record<string, string> | undefined;
  const called = body?.["To"] ?? body?.["Called"];
  return called ? { kind: "twilioNumber", value: called } : null;
};

/** The subset of Meta's payload this engine reads. */
export interface MetaWebhookBody {
  object?: string;
  entry?: Array<{
    id?: string;
    changes?: Array<{
      field?: string;
      value?: {
        metadata?: { phone_number_id?: string; display_phone_number?: string };
        messages?: Array<{
          id?: string;
          from?: string;
          timestamp?: string;
          type?: string;
          text?: { body?: string };
        }>;
        contacts?: Array<{ wa_id?: string; profile?: { name?: string } }>;
        statuses?: Array<{ id?: string; status?: string }>;
      };
    }>;
    messaging?: Array<{
      sender?: { id?: string };
      recipient?: { id?: string };
      timestamp?: number;
      message?: { mid?: string; text?: string };
    }>;
  }>;
}

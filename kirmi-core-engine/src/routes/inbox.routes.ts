import { Router, type Request, type Response } from "express";
import { z } from "zod";
import type { Container } from "../core/container.js";
import { ValidationError } from "../core/errors.js";
import { requireClientApiKey } from "../middleware/dashboard-auth.middleware.js";
import { rateLimit } from "../middleware/rate-limit.js";

/**
 * The human inbox.
 *
 * The socket pushes escalations the moment they happen; these routes are how a
 * dashboard loads the backlog on open, and how a person acts on one.
 *
 * The takeover toggle is here rather than buried in a settings page because it
 * is the control a salesperson reaches for mid conversation, and it has to be
 * one click away. Flipping it off stops the agent on the next check, which
 * happens inside the transaction that writes each reply, so it takes effect
 * even if the agent is mid flight on that thread.
 */
export function inboxRoutes(container: Container): Router {
  const router = Router();

  router.use(
    requireClientApiKey(container.db, container.config, "inbox:read"),
    rateLimit({ bucket: "inbox", limit: 300, windowSeconds: 60 }),
  );

  router.get("/escalations", (req: Request, res: Response) => {
    void (async () => {
      const clientId = requireTenant(req);
      res.json({ escalations: await container.escalations.listOpen(clientId) });
    })().catch((err: unknown) => fail(req, res, err));
  });

  router.post("/escalations/:id/acknowledge", (req: Request, res: Response) => {
    void (async () => {
      const clientId = requireTenant(req);
      const id = req.params["id"];
      if (!id) throw new ValidationError("Missing escalation id");

      const body = z.object({ by: z.string().min(1).max(120) }).parse(req.body);
      res.json({ escalation: await container.escalations.acknowledge(clientId, id, body.by) });
    })().catch((err: unknown) => fail(req, res, err));
  });

  router.post("/escalations/:id/resolve", (req: Request, res: Response) => {
    void (async () => {
      const clientId = requireTenant(req);
      const id = req.params["id"];
      if (!id) throw new ValidationError("Missing escalation id");

      // Handing the thread back to the agent is an explicit decision by the
      // person who just rescued it, never a default.
      const body = z.object({ reenableAi: z.boolean().default(false) }).parse(req.body ?? {});
      res.json({ escalation: await container.escalations.resolve(clientId, id, { reenableAi: body.reenableAi }) });
    })().catch((err: unknown) => fail(req, res, err));
  });

  /** The kill switch, exposed directly. */
  router.post("/conversations/:id/ai", (req: Request, res: Response) => {
    void (async () => {
      const clientId = requireTenant(req);
      const id = req.params["id"];
      if (!id) throw new ValidationError("Missing conversation id");

      const body = z.object({ enabled: z.boolean() }).parse(req.body);

      const conversation = await container.db.withTenant(clientId, async (tx) =>
        tx.conversation.update({
          where: { id },
          data: body.enabled
            ? { aiEnabled: true, state: "QUALIFIED", takeoverReason: null, takeoverAt: null }
            : { aiEnabled: false, state: "HUMAN_TAKEOVER", takeoverAt: new Date() },
        }),
      );

      await container.db.withTenant(clientId, async (tx) => {
        await container.audit.record(tx, clientId, {
          eventType: body.enabled ? "AI_ENABLED" : "AI_DISABLED",
          actor: "HUMAN",
          conversationId: id,
          payload: { source: "inbox" },
        });
      });

      res.json({ conversation });
    })().catch((err: unknown) => fail(req, res, err));
  });

  return router;
}

function requireTenant(req: Request): string {
  const clientId = req.routing?.clientId;
  if (!clientId) throw new ValidationError("Tenant not resolved");
  return clientId;
}

function fail(req: Request, res: Response, err: unknown): void {
  req.log?.error({ err }, "inbox request failed");
  if (res.headersSent) return;
  res.status(500).json({ error: { code: "INBOX_REQUEST_FAILED" } });
}

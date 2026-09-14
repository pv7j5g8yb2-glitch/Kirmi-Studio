import { Router, type Request, type Response } from "express";
import { z } from "zod";
import type { Container } from "../core/container.js";
import { ValidationError } from "../core/errors.js";
import { minutesLeftInWindow, requiresTemplate } from "../channels/messaging-window.js";
import { asyncHandler } from "../middleware/async-handler.js";
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

  /**
   * The live list.
   *
   * Ordered by the customer's last message rather than by ours, because the
   * question a person at the desk is answering is "who is waiting on me", and
   * a thread we replied to five seconds ago is not it.
   */
  router.get(
    "/conversations",
    asyncHandler(async (req: Request, res: Response) => {
      const clientId = requireTenant(req);
      const now = new Date();

      const rows = await container.db.withTenant(clientId, async (tx) =>
        tx.conversation.findMany({
          where: { clientId, closedAt: null },
          orderBy: [{ lastInboundAt: "desc" }, { updatedAt: "desc" }],
          take: 100,
          select: {
            id: true,
            channel: true,
            state: true,
            aiEnabled: true,
            language: true,
            lastInboundAt: true,
            lastOutboundAt: true,
            takeoverAt: true,
            customer: { select: { fullName: true } },
            messages: { orderBy: { createdAt: "desc" }, take: 1, select: { body: true, direction: true, createdAt: true } },
          },
        }),
      );

      res.json({
        conversations: rows.map((c) => ({
          id: c.id,
          channel: c.channel,
          state: c.state,
          aiEnabled: c.aiEnabled,
          language: c.language,
          customerName: c.customer?.fullName ?? null,
          lastInboundAt: c.lastInboundAt?.toISOString() ?? null,
          lastMessage: c.messages[0]
            ? {
                body: c.messages[0].body,
                direction: c.messages[0].direction,
                at: c.messages[0].createdAt.toISOString(),
              }
            : null,
          // The single most useful number on the screen: how long a person has
          // left before a free reply stops being possible on this thread.
          windowMinutesLeft: minutesLeftInWindow(c.lastInboundAt, now),
          windowClosed: requiresTemplate(c.channel, c.lastInboundAt, now),
          takenOver: c.takeoverAt !== null,
        })),
      });
    }),
  );

  /** One thread, oldest first, which is how a person reads a conversation. */
  router.get(
    "/conversations/:id/messages",
    asyncHandler(async (req: Request, res: Response) => {
      const clientId = requireTenant(req);
      const id = req.params["id"];
      if (!id) throw new ValidationError("Missing conversation id");

      const messages = await container.db.withTenant(clientId, async (tx) =>
        tx.message.findMany({
          where: { clientId, conversationId: id },
          orderBy: { createdAt: "asc" },
          take: 200,
          select: {
            id: true,
            direction: true,
            channel: true,
            body: true,
            mediaUrls: true,
            createdAt: true,
            latencyMs: true,
            meta: true,
          },
        }),
      );

      res.json({
        messages: messages.map((m) => ({
          id: m.id,
          direction: m.direction,
          channel: m.channel,
          body: m.body,
          mediaUrls: m.mediaUrls,
          at: m.createdAt.toISOString(),
          latencyMs: m.latencyMs,
          // Marks the ones the engine sent on its own, so a person can see at
          // a glance which messages were chases rather than replies.
          followUp: (m.meta as { kind?: string } | null)?.kind ?? null,
        })),
      });
    }),
  );

  /**
   * Send as a human.
   *
   * Taking over is implicit in speaking: if somebody types into a thread, the
   * agent stops. Requiring them to flip a switch first is a step that gets
   * skipped under pressure, and the failure mode is the agent and a person
   * both answering the same customer.
   */
  router.post(
    "/conversations/:id/reply",
    asyncHandler(async (req: Request, res: Response) => {
      const clientId = requireTenant(req);
      const id = req.params["id"];
      if (!id) throw new ValidationError("Missing conversation id");

      const body = z.object({ body: z.string().min(1).max(4_000), by: z.string().max(120).optional() }).parse(req.body);

      const conversation = await container.db.withTenant(clientId, async (tx) =>
        tx.conversation.findUnique({
          where: { id },
          select: { id: true, channel: true, customerId: true, lastInboundAt: true },
        }),
      );
      if (!conversation) throw new ValidationError("No such conversation");

      if (requiresTemplate(conversation.channel, conversation.lastInboundAt, new Date())) {
        // Better to refuse here than to let the carrier refuse silently and
        // leave a person believing they answered a customer.
        res.status(409).json({
          error: {
            code: "SERVICE_WINDOW_CLOSED",
            message:
              "More than 24 hours since this customer wrote, so WhatsApp will not accept a free reply. " +
              "An approved template is the only thing that can be sent.",
          },
        });
        return;
      }

      const identity = await container.db.withTenant(clientId, async (tx) =>
        tx.customerIdentity.findFirst({
          where: { clientId, customerId: conversation.customerId, channel: conversation.channel },
          select: { externalId: true },
        }),
      );
      if (!identity) throw new ValidationError("No reachable identity for this customer");

      const messageId = await container.db.withTenant(clientId, async (tx) => {
        await tx.conversation.update({
          where: { id },
          data: { aiEnabled: false, state: "HUMAN_TAKEOVER", takeoverAt: new Date(), ...(body.by ? { assignedToUserId: body.by } : {}) },
        });

        const message = await tx.message.create({
          data: {
            clientId,
            conversationId: id,
            direction: "OUTBOUND",
            channel: conversation.channel,
            body: body.body,
            meta: { sentBy: body.by ?? "inbox" },
          },
          select: { id: true },
        });

        await container.audit.record(tx, clientId, {
          eventType: "AI_DISABLED",
          actor: "HUMAN",
          conversationId: id,
          payload: { source: "inbox reply", by: body.by ?? null },
        });

        return message.id;
      });

      // A person has the thread, so nothing automated should still be chasing.
      await container.followUps.cancelFor(clientId, id, "a person replied");

      await container.dispatcher.dispatch({
        clientId,
        conversationId: id,
        messageId,
        channel: conversation.channel,
        to: identity.externalId,
        body: body.body,
      });

      res.json({ messageId, aiEnabled: false });
    }),
  );

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

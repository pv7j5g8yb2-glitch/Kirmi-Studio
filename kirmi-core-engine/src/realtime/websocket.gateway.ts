import type { Server as HttpServer } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import { parseApiKey, safeEqual } from "../core/crypto.js";
import type { Logger } from "../core/logger.js";
import type { TenantDatabase } from "../db/tenant-context.js";
import type { ClientConfigService } from "../services/client-config.service.js";
import type { EscalationBroadcaster, EscalationEvent } from "../services/escalation.service.js";

/**
 * ===========================================================================
 * THE HUMAN INBOX SOCKET
 * ===========================================================================
 *
 * When the engine hands a conversation to a person, that person needs to know
 * now, not on their next page refresh. A customer who has just been told a
 * colleague will pick this up is sitting there watching the screen.
 *
 * Isolation applies here exactly as it does to every other read path. Sockets
 * are held in per tenant sets and a publish only ever iterates one set. A
 * dashboard connected for one client cannot receive another client's
 * escalations, which would leak customer names, phone numbers and booking
 * values across a client boundary in real time.
 *
 * Authentication happens during the upgrade handshake, before the socket is
 * added to any set. An unauthenticated connection is closed, never parked.
 */
export class InboxGateway implements EscalationBroadcaster {
  private readonly server: WebSocketServer;
  /** clientId to that tenant's live sockets. The only routing table here. */
  private readonly rooms = new Map<string, Set<WebSocket>>();
  private heartbeat: NodeJS.Timeout | null = null;

  constructor(
    httpServer: HttpServer,
    private readonly db: TenantDatabase,
    private readonly configService: ClientConfigService,
    private readonly log: Logger,
  ) {
    // noServer so the upgrade can be authenticated before a socket exists.
    this.server = new WebSocketServer({ noServer: true });

    httpServer.on("upgrade", (request, socket, head) => {
      void (async () => {
        try {
          const url = new URL(request.url ?? "/", "http://localhost");
          if (url.pathname !== "/realtime/inbox") {
            socket.destroy();
            return;
          }

          const clientId = await this.authenticate(url.searchParams.get("key"));
          if (!clientId) {
            socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
            socket.destroy();
            return;
          }

          this.server.handleUpgrade(request, socket, head, (ws) => {
            this.join(clientId, ws);
          });
        } catch (err) {
          this.log.warn({ err }, "websocket upgrade failed");
          socket.destroy();
        }
      })();
    });

    // Half open sockets look connected and silently swallow every escalation
    // sent to them. The ping/pong sweep is what stops an inbox going quiet
    // without anyone noticing.
    this.heartbeat = setInterval(() => this.sweep(), 30_000);
    this.heartbeat.unref();
  }

  /**
   * Same key format and the same constant time comparison as the HTTP API.
   * One authentication story for both transports.
   */
  private async authenticate(raw: string | null): Promise<string | null> {
    if (!raw) return null;
    const parsed = parseApiKey(raw);
    if (!parsed) return null;

    try {
      const routing = await this.configService.resolveRouting({ kind: "slug", value: parsed.slug });
      const key = await this.db.withTenant(routing.clientId, async (tx) =>
        tx.clientApiKey.findFirst({ where: { keyPrefix: parsed.prefix, revokedAt: null } }),
      );
      if (!key || !safeEqual(key.keyHash, parsed.hash)) return null;
      if (!key.scopes.includes("inbox:read")) return null;
      return routing.clientId;
    } catch {
      return null;
    }
  }

  private join(clientId: string, ws: WebSocket): void {
    const room = this.rooms.get(clientId) ?? new Set<WebSocket>();
    room.add(ws);
    this.rooms.set(clientId, room);

    let alive = true;
    ws.on("pong", () => {
      alive = true;
    });
    ws.on("close", () => this.leave(clientId, ws));
    ws.on("error", () => this.leave(clientId, ws));
    Object.defineProperty(ws, "kirmiAlive", { get: () => alive, set: (v: boolean) => (alive = v), configurable: true });

    ws.send(JSON.stringify({ type: "connected", clientId, at: new Date().toISOString() }));
    this.log.info({ clientId, sockets: room.size }, "inbox socket connected");
  }

  private leave(clientId: string, ws: WebSocket): void {
    const room = this.rooms.get(clientId);
    if (!room) return;
    room.delete(ws);
    if (room.size === 0) this.rooms.delete(clientId);
  }

  private sweep(): void {
    for (const [clientId, room] of this.rooms) {
      for (const ws of room) {
        const holder = ws as WebSocket & { kirmiAlive?: boolean };
        if (holder.kirmiAlive === false) {
          ws.terminate();
          this.leave(clientId, ws);
          continue;
        }
        holder.kirmiAlive = false;
        ws.ping();
      }
    }
  }

  /**
   * Publish to one tenant's inbox.
   *
   * Fire and forget by design. This is called after the takeover has already
   * been committed and persisted, so a dead socket costs a notification, never
   * the handover itself. The escalation is in the database either way.
   */
  publish(clientId: string, event: EscalationEvent): void {
    const room = this.rooms.get(clientId);
    if (!room || room.size === 0) {
      this.log.info({ clientId, escalationId: event.escalationId }, "no inbox connected, escalation waiting in the queue");
      return;
    }

    const frame = JSON.stringify(event);
    for (const ws of room) {
      try {
        if (ws.readyState === ws.OPEN) ws.send(frame);
      } catch (err) {
        this.log.warn({ err, clientId }, "failed to push to an inbox socket");
      }
    }
  }

  async close(): Promise<void> {
    if (this.heartbeat) clearInterval(this.heartbeat);
    for (const room of this.rooms.values()) {
      for (const ws of room) ws.close(1001, "server shutting down");
    }
    this.rooms.clear();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}

/**
 * Used when no socket server is running, for example inside a queue worker
 * process. Escalations still persist; only the live push is absent.
 */
export class NullBroadcaster implements EscalationBroadcaster {
  constructor(private readonly log: Logger) {}
  publish(clientId: string, event: EscalationEvent): void {
    this.log.info({ clientId, escalationId: event.escalationId }, "escalation recorded, no socket transport in this process");
  }
}

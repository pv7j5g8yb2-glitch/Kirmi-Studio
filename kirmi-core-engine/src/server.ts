import { createServer, type Server } from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import express, { type Express } from "express";
import helmet from "helmet";
import { env } from "./config/env.js";
import { buildContainer, type Container } from "./core/container.js";
import { logger } from "./core/logger.js";
import { captureRawBody, requestContext } from "./middleware/request-context.js";
import { errorHandler, notFoundHandler } from "./middleware/error-handler.js";
import { buildRoutes } from "./routes/index.js";
import { disconnectPrisma } from "./db/prisma.js";
import { disconnectRedis } from "./cache/redis.js";
import { closeQueues, scheduleRecurringJobs } from "./queue/queues.js";

/**
 * ===========================================================================
 * THE API GATEWAY
 * ===========================================================================
 *
 * Two processes run this codebase. This one serves HTTP and the inbox socket.
 * The other (queue/workers/index.ts) drains the queues. Same image, same
 * container wiring, different entry point.
 *
 * Splitting them is not ceremony. A webhook must be acknowledged in under a
 * couple of seconds or the carrier redelivers it, and background work that
 * shares a process with that endpoint eventually competes with it for the event
 * loop. Separating them means a slow job costs throughput, never correctness.
 */

export function createApp(container: Container): Express {
  const app = express();

  // Behind a load balancer. Without this, req.ip is the balancer and every rate
  // limit bucket collapses into one.
  app.set("trust proxy", true);
  app.disable("x-powered-by");

  app.use(
    helmet({
      // This service returns JSON and TwiML to machines. No browser surface,
      // so the browser-oriented policies are noise here.
      contentSecurityPolicy: false,
      crossOriginEmbedderPolicy: false,
    }),
  );

  app.use(requestContext());

  // The raw body is captured on the way through, because signature verification
  // needs the exact bytes Meta hashed. A re-serialised object is not those bytes.
  // The size cap is a cheap guard against a memory exhaustion attempt on a
  // public endpoint.
  app.use(express.json({ limit: "1mb", verify: captureRawBody }));
  app.use(express.urlencoded({ extended: false, limit: "1mb", verify: captureRawBody }));

  // The human inbox, served from this same process.
  //
  // One less thing to deploy, and more importantly one less origin: the page
  // calls /api/inbox on the host it was served from, so there is no CORS to
  // configure and no second set of credentials to keep in step. It is a static
  // file that holds no secret of its own; the API key is typed by the person
  // using it and lives only in their browser.
  app.use(
    "/inbox",
    express.static(inboxAssetPath(), {
      index: "inbox.html",
      extensions: ["html"],
      maxAge: "5m",
      setHeaders: (res) => {
        // A takeover screen has no business being framed or indexed.
        res.setHeader("X-Frame-Options", "DENY");
        res.setHeader("X-Robots-Tag", "noindex, nofollow");
      },
    }),
  );

  // The client's own results page, same origin and same static directory.
  app.use(
    "/dashboard",
    express.static(inboxAssetPath(), {
      index: "dashboard.html",
      extensions: ["html"],
      maxAge: "5m",
      setHeaders: (res) => {
        res.setHeader("X-Frame-Options", "DENY");
        res.setHeader("X-Robots-Tag", "noindex, nofollow");
      },
    }),
  );

  app.use(buildRoutes(container));

  app.use(notFoundHandler());
  app.use(errorHandler());

  return app;
}

export interface RunningServer {
  server: Server;
  container: Container;
  shutdown: () => Promise<void>;
}

export async function startServer(): Promise<RunningServer> {
  const config = env();
  const log = logger();

  // The HTTP server is created first so the inbox socket can attach to its
  // upgrade event during container construction.
  const httpServer = createServer();
  const container = buildContainer({ httpServer });
  const app = createApp(container);
  httpServer.on("request", app);

  await new Promise<void>((resolve) => httpServer.listen(config.PORT, resolve));
  log.info({ port: config.PORT, env: config.NODE_ENV }, "kirmi core engine listening");

  // The API process owns the recurring schedule; workers only consume it.
  // Registering it from every worker would create one duplicate sweeper per pod.
  try {
    await scheduleRecurringJobs();
  } catch (err) {
    log.error({ err }, "could not register recurring jobs, hold sweeping may not run");
  }

  const shutdown = async (): Promise<void> => {
    log.info("shutting down");
    // Order matters: stop accepting, then drain, then close the things in use.
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    await container.gateway?.close();
    await closeQueues();
    await disconnectPrisma();
    await disconnectRedis();
    log.info("shutdown complete");
  };

  return { server: httpServer, container, shutdown };
}

/**
 * Only runs when this file is the entry point, so importing it from a test does
 * not start listening on a port.
 */
const isEntryPoint = process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`;

if (isEntryPoint) {
  startServer()
    .then(({ shutdown }) => {
      for (const signal of ["SIGTERM", "SIGINT"] as const) {
        process.once(signal, () => {
          void shutdown().then(
            () => process.exit(0),
            () => process.exit(1),
          );
        });
      }
    })
    .catch((err: unknown) => {
      logger().fatal({ err }, "failed to start");
      process.exit(1);
    });
}

/**
 * Where the inbox page lives, in both source and build layouts.
 *
 * `tsc` emits to dist/ but does not copy static assets, so a path resolved
 * relative to this module points at dist/../public in a build and at
 * src/../public when running from source. Both land on the same directory,
 * which is the point.
 */
function inboxAssetPath(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "public");
}

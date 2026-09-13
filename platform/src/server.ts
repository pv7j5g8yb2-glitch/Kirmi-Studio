import Fastify from "fastify";
import cookie from "@fastify/cookie";
import formbody from "@fastify/formbody";
import rateLimit from "@fastify/rate-limit";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { env } from "./config/env.js";
import { registerRoutes } from "./api/routes.js";
import { registerWebhooks } from "./api/webhooks.js";
import { getPool, closePool } from "./db/index.js";
import { startScheduler } from "./jobs/scheduler.js";

const here = dirname(fileURLToPath(import.meta.url));

export async function buildServer() {
  const cfg = env();
  const app = Fastify({
    logger: { level: cfg.LOG_LEVEL, redact: ["req.headers.authorization", "req.headers.cookie"] },
    trustProxy: true,
    bodyLimit: 1_048_576,
  });

  /**
   * Webhook signatures are computed over the exact bytes Meta sent. Re-serialising the
   * parsed object changes key order and whitespace, so the raw buffer is kept alongside.
   */
  app.addContentTypeParser("application/json", { parseAs: "buffer" }, (req, body, done) => {
    (req as unknown as { rawBody: Buffer }).rawBody = body as Buffer;
    try {
      done(null, (body as Buffer).length ? JSON.parse((body as Buffer).toString("utf8")) : {});
    } catch (e) {
      done(e as Error, undefined);
    }
  });

  await app.register(cookie, { secret: cfg.SESSION_SECRET });
  await app.register(formbody);
  await app.register(rateLimit, {
    max: 300,
    timeWindow: "1 minute",
    // Provider webhooks burst far above a human rate; they are authenticated by signature.
    allowList: (req) => req.url.startsWith("/webhooks/"),
  });

  app.get("/healthz", async () => {
    const started = Date.now();
    await getPool().query("SELECT 1");
    return { ok: true, dbLatencyMs: Date.now() - started, mode: cfg.NODE_ENV };
  });

  app.get("/readyz", async (_req, reply) => {
    try {
      await getPool().query("SELECT 1");
      return { ready: true };
    } catch {
      return reply.code(503).send({ ready: false });
    }
  });

  await registerWebhooks(app);
  await registerRoutes(app);

  /**
   * The console is three known files. Serving them from an explicit allow-list rather
   * than a directory server means there is no path to traverse: an unknown path never
   * reaches the filesystem at all.
   */
  const ASSETS: Record<string, { file: string; type: string }> = {
    "/": { file: "index.html", type: "text/html; charset=utf-8" },
    "/index.html": { file: "index.html", type: "text/html; charset=utf-8" },
    "/app.css": { file: "app.css", type: "text/css; charset=utf-8" },
    "/app.js": { file: "app.js", type: "text/javascript; charset=utf-8" },
  };
  const cache = new Map<string, Buffer>();
  for (const [route, meta] of Object.entries(ASSETS)) {
    app.get(route, async (_req, reply) => {
      let body = cache.get(meta.file);
      if (!body) {
        body = await readFile(join(here, "web", meta.file));
        if (cfg.NODE_ENV === "production") cache.set(meta.file, body);
      }
      return reply
        .type(meta.type)
        .header("cache-control", cfg.NODE_ENV === "production" ? "public, max-age=300" : "no-store")
        .header("x-content-type-options", "nosniff")
        .header("x-frame-options", "DENY")
        .header("referrer-policy", "same-origin")
        .send(body);
    });
  }

  app.setNotFoundHandler((_req, reply) => reply.code(404).send({ error: "not_found" }));

  return app;
}

const isEntry = process.argv[1] && (process.argv[1].endsWith("server.ts") || process.argv[1].endsWith("server.js"));
if (isEntry) {
  const app = await buildServer();
  const cfg = env();
  const stopScheduler = startScheduler(app.log);
  await app.listen({ port: cfg.PORT, host: "0.0.0.0" });
  app.log.info(`Kirmi platform listening on ${cfg.PORT}`);

  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, async () => {
      app.log.info(`${sig} received, shutting down`);
      stopScheduler();
      await app.close();
      await closePool();
      process.exit(0);
    });
  }
}

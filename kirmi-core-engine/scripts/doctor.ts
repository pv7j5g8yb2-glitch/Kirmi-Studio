import { env } from "../src/config/env.js";
import { redis } from "../src/cache/redis.js";
import { disconnectRedis } from "../src/cache/redis.js";
import { decryptSecret, encryptSecret } from "../src/core/crypto.js";
import { disconnectPrisma, prisma } from "../src/db/prisma.js";
import { withTenant } from "../src/db/tenant-context.js";

/**
 * ===========================================================================
 * PREFLIGHT
 * ===========================================================================
 *
 *   npm run doctor
 *
 * One command that answers one question: is it safe to point a real customer
 * at this deployment?
 *
 * Written for the person doing the deploy, who may not be the person who wrote
 * the engine. Every check either passes or says exactly what to do, in a
 * sentence, with no jargon that assumes the reader already knows the system.
 *
 * The checks are ordered by how badly they fail rather than by convenience.
 * The first three are the ones that produce NO error of their own when they
 * are wrong:
 *
 *   1. The app role holding BYPASSRLS. Every tenant policy stops applying and
 *      nothing is logged. With one client it looks completely normal; the
 *      moment there are two, each can read the other's customers.
 *   2. Row level security switched off on a table. Same silence.
 *   3. An encryption key that does not match the stored secrets. Meta tokens
 *      decrypt to nonsense, sends fail, and the error surfaces three layers
 *      away from the cause.
 *
 * Exit code is 1 if anything failed, so this can gate a deploy.
 */

type Level = "pass" | "warn" | "fail";
interface Check {
  name: string;
  level: Level;
  detail: string;
  /** What the person running this should actually do about it. */
  fix?: string;
}

const results: Check[] = [];
const ok = (name: string, detail: string): void => void results.push({ name, level: "pass", detail });
const warn = (name: string, detail: string, fix: string): void =>
  void results.push({ name, level: "warn", detail, fix });
const fail = (name: string, detail: string, fix: string): void =>
  void results.push({ name, level: "fail", detail, fix });

async function main(): Promise<void> {
  const config = env();

  // --- 1. The database role -------------------------------------------------
  //
  // The single most important line in this file. A superuser or a BYPASSRLS
  // role silently ignores every policy, which means the isolation the whole
  // product rests on is off with nothing to indicate it.
  try {
    const rows = await prisma().$queryRawUnsafe<
      Array<{ current_user: string; rolsuper: boolean; rolbypassrls: boolean }>
    >(
      `SELECT current_user, r.rolsuper, r.rolbypassrls
         FROM pg_roles r WHERE r.rolname = current_user`,
    );
    const role = rows[0];
    if (!role) {
      fail("Database role", "Could not read the connected role", "Check DATABASE_URL points at a real database.");
    } else if (role.rolsuper || role.rolbypassrls) {
      fail(
        "Database role",
        `Connected as "${role.current_user}", which bypasses row level security`,
        "DATABASE_URL must use the kirmi_app role. Run `npm run db:roles` and point DATABASE_URL at kirmi_app. " +
          "Do NOT go live until this passes: every client would be able to read every other client's data.",
      );
    } else {
      ok("Database role", `Connected as "${role.current_user}", which cannot bypass row level security`);
    }
  } catch (err) {
    fail("Database role", describe(err), "Is the database reachable, and is DATABASE_URL correct?");
  }

  // --- 2. Row level security is on, on every tenant table -------------------
  try {
    const rows = await prisma().$queryRawUnsafe<Array<{ relname: string; forced: boolean; policies: bigint }>>(
      `SELECT c.relname,
              c.relforcerowsecurity AS forced,
              (SELECT count(*) FROM pg_policy p WHERE p.polrelid = c.oid) AS policies
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public'
          AND c.relkind = 'r'
          AND c.relname NOT IN ('_prisma_migrations', 'tenant_directory')
        ORDER BY c.relname`,
    );

    const unprotected = rows.filter((r) => !r.forced || Number(r.policies) === 0).map((r) => r.relname);
    if (rows.length === 0) {
      fail("Tenant isolation", "No tables found", "Run `npm run prisma:migrate` first.");
    } else if (unprotected.length > 0) {
      fail(
        "Tenant isolation",
        `${unprotected.length} table(s) are readable across clients: ${unprotected.join(", ")}`,
        "Each needs ENABLE plus FORCE ROW LEVEL SECURITY and a tenant_isolation policy. " +
          "See the migration named tenant_isolation_and_invariants for the pattern.",
      );
    } else {
      ok("Tenant isolation", `${rows.length} tables, all forced and carrying a policy`);
    }
  } catch (err) {
    fail("Tenant isolation", describe(err), "Could not inspect the tables.");
  }

  // --- 3. Migrations are actually applied -----------------------------------
  try {
    const rows = await prisma().$queryRawUnsafe<Array<{ migration_name: string; finished_at: Date | null }>>(
      `SELECT migration_name, finished_at FROM _prisma_migrations ORDER BY started_at DESC LIMIT 5`,
    );
    const pending = rows.filter((r) => r.finished_at === null);
    if (pending.length > 0) {
      fail(
        "Migrations",
        `${pending.length} did not finish: ${pending.map((p) => p.migration_name).join(", ")}`,
        "Run `npm run prisma:migrate` with MIGRATION_DATABASE_URL set, and read the error it prints.",
      );
    } else {
      ok("Migrations", `Latest applied: ${rows[0]?.migration_name ?? "none"}`);
    }
  } catch {
    fail("Migrations", "No migration history table", "Run `npm run prisma:migrate` before anything else.");
  }

  // --- 4. The encryption key round trips ------------------------------------
  //
  // A key that does not match what encrypted the stored secrets is a quiet
  // disaster: Meta tokens come back as nonsense and every send fails with an
  // authentication error that points at Meta rather than at the key.
  if (!config.SECRETS_ENCRYPTION_KEY) {
    fail("Encryption key", "SECRETS_ENCRYPTION_KEY is not set", "Generate one with: openssl rand -base64 32");
  } else {
    try {
      const probe = "kirmi-doctor-probe";
      if (decryptSecret(encryptSecret(probe)) !== probe) throw new Error("round trip mismatch");
      ok("Encryption key", "32 bytes, and encrypt/decrypt round trips");

      // Does it match what is ALREADY in the database? A rotated key that was
      // never migrated looks fine above and fails on the first real send.
      const stored = await prisma().$queryRawUnsafe<Array<{ meta_access_token_encrypted: string | null }>>(
        `SELECT meta_access_token_encrypted FROM client_configurations
          WHERE meta_access_token_encrypted IS NOT NULL LIMIT 1`,
      );
      const sample = stored[0]?.meta_access_token_encrypted;
      if (sample) {
        try {
          decryptSecret(sample);
          ok("Stored credentials", "The saved client credentials decrypt with this key");
        } catch {
          fail(
            "Stored credentials",
            "The saved client credentials do NOT decrypt with this key",
            "SECRETS_ENCRYPTION_KEY has changed since those were saved. Restore the old key, or re-enter the " +
              "client's Meta token and payment keys so they are encrypted with the new one.",
          );
        }
      }
    } catch (err) {
      fail("Encryption key", describe(err), "It must be exactly 32 bytes, base64 encoded.");
    }
  }

  // --- 5. Redis -------------------------------------------------------------
  try {
    const pong = await redis().ping();
    if (pong !== "PONG") throw new Error(`unexpected reply: ${pong}`);
    ok("Redis", "Reachable. Holds the conversation cache and the job queues");
  } catch (err) {
    fail(
      "Redis",
      describe(err),
      "Without Redis nothing is delivered, because every outbound message goes through a queue. Check REDIS_URL.",
    );
  }

  // --- 6. The model ---------------------------------------------------------
  if (!config.ANTHROPIC_API_KEY) {
    fail("Model access", "ANTHROPIC_API_KEY is not set", "Without it the agent cannot reply to anybody.");
  } else {
    try {
      // One token, purely to prove the key is accepted. Cheaper than a real turn.
      const response = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": config.ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({ model: config.LLM_MODEL, max_tokens: 1, messages: [{ role: "user", content: "hi" }] }),
        signal: AbortSignal.timeout(15_000),
      });
      if (response.status === 401 || response.status === 403) {
        fail("Model access", "The key was rejected", "Check ANTHROPIC_API_KEY, and that the account has credit.");
      } else if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { error?: { message?: string } };
        warn("Model access", `HTTP ${response.status}: ${body.error?.message ?? "unknown"}`, `Model is ${config.LLM_MODEL}.`);
      } else {
        ok("Model access", `${config.LLM_MODEL} responded`);
      }
    } catch (err) {
      warn("Model access", describe(err), "Could not reach the API. Check outbound network access from this host.");
    }
  }

  // --- 7. Public URL --------------------------------------------------------
  //
  // Meta and Twilio both call back on this. Twilio signs the exact URL it
  // called, so a mismatch rejects every genuine request as a forgery.
  if (config.PUBLIC_BASE_URL.startsWith("http://localhost")) {
    warn(
      "Public URL",
      `PUBLIC_BASE_URL is ${config.PUBLIC_BASE_URL}`,
      "Fine locally. Before go-live it must be the https address the outside world calls, or webhook " +
        "signature checks will reject real requests.",
    );
  } else if (!config.PUBLIC_BASE_URL.startsWith("https://")) {
    fail("Public URL", "PUBLIC_BASE_URL is not https", "Meta will not deliver webhooks to a plain http address.");
  } else {
    ok("Public URL", config.PUBLIC_BASE_URL);
  }

  // --- 8. Dashboard key -----------------------------------------------------
  if (!config.DASHBOARD_API_KEY) {
    warn("Inbox", "DASHBOARD_API_KEY is not set", "The human inbox socket needs it. Any long random string.");
  } else {
    ok("Inbox", "Socket key is set");
  }

  // --- 9. Per client readiness ---------------------------------------------
  //
  // Everything above is about the deployment. This is about whether any actual
  // client could take an enquiry right now.
  //
  // Note the two step read. tenant_directory is the one table outside row
  // level security, because a webhook has to be routed to a tenant before it
  // is known which tenant it belongs to. Everything else has to be read INSIDE
  // that client's own scope, exactly as the application does it. A first draft
  // of this check joined straight onto clients and got back nothing at all,
  // which was row level security behaving perfectly and the check being wrong.
  try {
    const directory = await prisma().tenantDirectory.findMany({
      orderBy: { slug: "asc" },
      select: { clientId: true, slug: true, tradingName: true, status: true, metaPhoneNumberId: true },
    });

    if (directory.length === 0) {
      warn("Clients", "No clients configured yet", "Run `npm run onboard -- <file>.json` before go-live.");
    } else {
      for (const entry of directory) {
        const detail = await withTenant(entry.clientId, async (tx) => {
          const [config, vehicles] = await Promise.all([
            tx.clientConfiguration.findUnique({
              where: { clientId: entry.clientId },
              select: { metaAccessTokenEncrypted: true, messageTemplates: true, followUpPolicy: true },
            }),
            tx.vehicle.count({ where: { clientId: entry.clientId, active: true } }),
          ]);
          return { config, vehicles };
        });

        const templates = Array.isArray(detail.config?.messageTemplates)
          ? (detail.config.messageTemplates as unknown[]).length
          : 0;
        const rules =
          detail.config?.followUpPolicy && typeof detail.config.followUpPolicy === "object"
            ? ((detail.config.followUpPolicy as { rules?: unknown[] }).rules?.length ?? 0)
            : 0;

        const problems: string[] = [];
        if (!entry.metaPhoneNumberId) problems.push("no WhatsApp number id");
        if (!detail.config?.metaAccessTokenEncrypted) problems.push("no Meta access token");
        if (detail.vehicles === 0) problems.push("no vehicles loaded");
        if (templates === 0) problems.push("no approved templates, so no follow up can ever be sent");
        if (rules === 0) problems.push("no follow up rules, so quiet customers will never be chased");
        if (entry.status !== "ACTIVE") problems.push(`status is ${entry.status}`);

        if (problems.length > 0) {
          warn(`Client: ${entry.tradingName}`, problems.join("; "), "Fix before pointing customers at this client.");
        } else {
          ok(
            `Client: ${entry.tradingName}`,
            `${detail.vehicles} vehicles, ${templates} templates, ${rules} follow up rules, ready`,
          );
        }
      }
    }
  } catch (err) {
    warn("Clients", describe(err), "Could not read the client list.");
  }

  report();
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function report(): void {
  const failures = results.filter((r) => r.level === "fail");
  const warnings = results.filter((r) => r.level === "warn");

  const mark = { pass: "  OK  ", warn: " WARN ", fail: " FAIL " } as const;

  process.stdout.write("\n");
  for (const r of results) {
    process.stdout.write(`[${mark[r.level]}] ${r.name}\n`);
    process.stdout.write(`           ${r.detail}\n`);
    if (r.fix) process.stdout.write(`           -> ${r.fix}\n`);
    process.stdout.write("\n");
  }

  if (failures.length > 0) {
    process.stdout.write(
      `${failures.length} problem(s) must be fixed before this takes a real customer. ` +
        `${warnings.length} warning(s).\n\n`,
    );
    process.exitCode = 1;
    return;
  }

  if (warnings.length > 0) {
    process.stdout.write(`No blockers. ${warnings.length} warning(s) worth reading above.\n\n`);
    return;
  }

  process.stdout.write("Everything checks out. Safe to take a real enquiry.\n\n");
}

main()
  .catch((err: unknown) => {
    process.stdout.write(`\nThe check itself could not run: ${describe(err)}\n\n`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await disconnectPrisma().catch(() => undefined);
    await disconnectRedis().catch(() => undefined);
  });

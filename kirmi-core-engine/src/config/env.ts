import { z } from "zod";

/**
 * Platform level configuration.
 *
 * The line this file draws matters more than its contents: what lives here is
 * what belongs to Kirmi Studio and is identical for every client. A client's
 * Meta secret, opening hours, VAT rate or fee deal is NOT here, it is a row in
 * client_configurations. That is the whole reason a new client is an insert
 * rather than a deploy.
 */

const booleanish = z
  .union([z.boolean(), z.string()])
  .transform((v) => (typeof v === "boolean" ? v : ["1", "true", "yes", "on"].includes(v.toLowerCase())));

const csv = z
  .string()
  .optional()
  .transform((v) =>
    (v ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  PUBLIC_BASE_URL: z.string().url().default("http://localhost:3000"),

  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  MIGRATION_DATABASE_URL: z.string().optional(),
  DATABASE_POOL_SIZE: z.coerce.number().int().positive().max(100).default(10),
  DATABASE_STATEMENT_TIMEOUT_MS: z.coerce.number().int().positive().default(8_000),

  REDIS_URL: z.string().min(1, "REDIS_URL is required"),
  REDIS_KEY_PREFIX: z.string().default("kirmi"),

  REPLY_SLA_MS: z.coerce.number().int().positive().default(15_000),
  REPLY_TARGET_MS: z.coerce.number().int().positive().default(3_000),

  IDEMPOTENCY_TTL_SECONDS: z.coerce.number().int().positive().default(86_400),
  DEFAULT_HOLD_TTL_MINUTES: z.coerce.number().int().positive().default(30),

  ANTHROPIC_API_KEY: z.string().optional(),
  LLM_MODEL: z.string().default("claude-sonnet-5"),
  LLM_TIMEOUT_MS: z.coerce.number().int().positive().default(6_000),

  META_APP_SECRET: z.string().optional(),
  META_WEBHOOK_VERIFY_TOKEN: z.string().optional(),
  TWILIO_AUTH_TOKEN: z.string().optional(),

  SECRETS_ENCRYPTION_KEY: z.string().optional(),

  DASHBOARD_API_KEY: z.string().optional(),
  DASHBOARD_ALLOWED_ORIGINS: csv,

  /** Escape hatch for local work only, never honoured when NODE_ENV=production. */
  ALLOW_UNSIGNED_WEBHOOKS: booleanish.default(false),
});

export type Env = z.infer<typeof schema>;

let cached: Env | null = null;

/**
 * Parsed once, then memoised. Reading process.env directly anywhere else in the
 * codebase is a lint level mistake: it skips validation and makes the set of
 * variables the service actually needs impossible to enumerate.
 */
export function env(): Env {
  if (cached) return cached;

  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const detail = parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Invalid environment configuration:\n${detail}`);
  }

  const value = parsed.data;

  // Production refuses to start in a configuration that would be unsafe rather
  // than starting and being unsafe quietly.
  if (value.NODE_ENV === "production") {
    const missing: string[] = [];
    if (!value.SECRETS_ENCRYPTION_KEY) missing.push("SECRETS_ENCRYPTION_KEY");
    if (!value.DASHBOARD_API_KEY) missing.push("DASHBOARD_API_KEY");
    if (missing.length > 0) {
      throw new Error(`Refusing to start in production without: ${missing.join(", ")}`);
    }
    if (value.ALLOW_UNSIGNED_WEBHOOKS) {
      throw new Error("ALLOW_UNSIGNED_WEBHOOKS cannot be enabled in production");
    }
  }

  cached = value;
  return cached;
}

/** Test helper. Forces the next env() call to re-read process.env. */
export function resetEnvCache(): void {
  cached = null;
}

export function isProduction(): boolean {
  return env().NODE_ENV === "production";
}

import { z } from "zod";

/**
 * Every secret enters the process here and nowhere else. Nothing in src/web ever
 * imports this module — the browser console talks to the API and is served no keys.
 */
const Schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.string().default("info"),

  DATABASE_URL: z.string().min(1),

  /** Public base URL, used to build webhook + payment return URLs. */
  PUBLIC_BASE_URL: z.string().url().default("http://localhost:3000"),

  /** Signing key for operator sessions. Must be set in production. */
  SESSION_SECRET: z.string().min(16).default("dev-only-insecure-session-secret"),

  // ---- WhatsApp (Meta Cloud API) ----
  WHATSAPP_APP_SECRET: z.string().optional(),
  WHATSAPP_ACCESS_TOKEN: z.string().optional(),
  WHATSAPP_PHONE_NUMBER_ID: z.string().optional(),
  WHATSAPP_VERIFY_TOKEN: z.string().optional(),
  WHATSAPP_API_VERSION: z.string().default("v21.0"),
  WHATSAPP_GRAPH_BASE: z.string().url().default("https://graph.facebook.com"),

  // ---- Instagram Messaging ----
  INSTAGRAM_APP_SECRET: z.string().optional(),
  INSTAGRAM_ACCESS_TOKEN: z.string().optional(),
  INSTAGRAM_ACCOUNT_ID: z.string().optional(),
  INSTAGRAM_VERIFY_TOKEN: z.string().optional(),

  // ---- Telephony / missed call ----
  VOICE_PROVIDER: z.enum(["none", "twilio", "generic"]).default("none"),
  VOICE_WEBHOOK_SECRET: z.string().optional(),

  // ---- Payments ----
  PAYMENT_PROVIDER: z.enum(["none", "stripe"]).default("none"),
  STRIPE_SECRET_KEY: z.string().optional(),
  STRIPE_WEBHOOK_SECRET: z.string().optional(),

  // ---- LLM ----
  LLM_PROVIDER: z.enum(["deterministic", "anthropic"]).default("deterministic"),
  ANTHROPIC_API_KEY: z.string().optional(),
  ANTHROPIC_MODEL: z.string().default("claude-sonnet-5"),
});

export type Env = z.infer<typeof Schema>;

let cached: Env | null = null;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = Schema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  const env = parsed.data;
  if (env.NODE_ENV === "production" && env.SESSION_SECRET.startsWith("dev-only")) {
    throw new Error("SESSION_SECRET must be set to a real secret in production");
  }
  return env;
}

export function env(): Env {
  if (!cached) cached = loadEnv();
  return cached;
}

/** Test helper: forget the memoised env so a test can vary configuration. */
export function resetEnvCache(): void {
  cached = null;
}

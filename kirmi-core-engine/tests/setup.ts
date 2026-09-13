/**
 * Test environment defaults.
 *
 * Set before any module reads env(), so the config module memoises a valid
 * configuration rather than throwing. Real values from the shell always win, so
 * CI can point these at its own services.
 */
const defaults: Record<string, string> = {
  NODE_ENV: "test",
  LOG_LEVEL: "silent",
  DATABASE_URL: "postgresql://kirmi_app:local@127.0.0.1:55432/kirmi_test?schema=public",
  MIGRATION_DATABASE_URL: "postgresql://kirmi_migrate:local@127.0.0.1:55432/kirmi_test?schema=public",
  REDIS_URL: "redis://127.0.0.1:56379",
  REDIS_KEY_PREFIX: "kirmi-test",
  // 32 bytes, base64. A fixed key so encrypt/decrypt round trips are reproducible.
  SECRETS_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
  DASHBOARD_API_KEY: "test-dashboard-key",
  REPLY_SLA_MS: "15000",
  REPLY_TARGET_MS: "3000",
};

for (const [key, value] of Object.entries(defaults)) {
  process.env[key] ??= value;
}

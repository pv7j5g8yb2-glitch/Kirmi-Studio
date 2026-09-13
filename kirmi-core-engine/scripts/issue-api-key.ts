import { generateApiKey, parseApiKey, sha256Hex } from "../src/core/crypto.js";
import { logger } from "../src/core/logger.js";
import { disconnectPrisma, prisma } from "../src/db/prisma.js";
import { withTenant } from "../src/db/tenant-context.js";

/**
 * Issue a dashboard API key for a client.
 *
 * The key is printed once and never stored in clear: only its sha256 goes into
 * the database, so a dump of client_api_keys is not a set of working
 * credentials. Losing it means issuing a new one and revoking the old, which is
 * the correct trade.
 *
 *   npx tsx scripts/issue-api-key.ts <slug> ["label"]
 *   npx tsx scripts/issue-api-key.ts deiz "Ops dashboard"
 *
 * Revoking:
 *   UPDATE client_api_keys SET revoked_at = now() WHERE id = '...';
 *   (inside a transaction with app.current_client_id set, as ever)
 */
async function main(): Promise<void> {
  const log = logger();
  const slug = process.argv[2];
  const label = process.argv[3] ?? "Dashboard";

  if (!slug) {
    throw new Error("Usage: tsx scripts/issue-api-key.ts <slug> [label]");
  }

  // The routing projection is readable without a tenant scope, which is the
  // only reason this lookup can happen before we know the clientId.
  const routing = await prisma().tenantDirectory.findUnique({ where: { slug } });
  if (!routing) throw new Error(`No client with slug "${slug}"`);

  const key = generateApiKey(slug);
  const parsed = parseApiKey(key);
  if (!parsed) throw new Error("generated a key that does not parse, which should be impossible");

  const created = await withTenant(routing.clientId, async (tx) =>
    tx.clientApiKey.create({
      data: {
        clientId: routing.clientId,
        label,
        keyPrefix: parsed.prefix,
        keyHash: sha256Hex(key),
        scopes: ["metrics:read", "inbox:read", "inbox:write"],
      },
    }),
  );

  log.info({ clientId: routing.clientId, keyId: created.id, label }, "api key issued");

  // eslint-disable-next-line no-console
  console.log(
    [
      "",
      `  Key issued for ${routing.tradingName} (${slug}).`,
      `    id:     ${created.id}`,
      `    scopes: ${created.scopes.join(", ")}`,
      `    key:    ${key}`,
      "",
      "  Shown once. Only its hash is stored.",
      "",
    ].join("\n"),
  );
}

main()
  .catch((err: unknown) => {
    logger().fatal({ err }, "could not issue key");
    process.exitCode = 1;
  })
  .finally(() => {
    void disconnectPrisma();
  });

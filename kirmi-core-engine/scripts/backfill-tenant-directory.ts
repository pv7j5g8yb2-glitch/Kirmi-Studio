import { PrismaClient } from "@prisma/client";
import { logger } from "../src/core/logger.js";

/**
 * Rebuild the routing projection.
 *
 * Needed only in one situation: applying migration 0003 to a database that
 * already carried clients. From then on the triggers keep it current and this
 * script is never required again.
 *
 * It must run as the break glass role (kirmi_admin, the one with BYPASSRLS),
 * because enumerating every tenant is by definition a cross tenant read and
 * every other role in this system is correctly forbidden from doing it.
 *
 *   ADMIN_DATABASE_URL=postgresql://kirmi_admin:...@host/kirmi npx tsx scripts/backfill-tenant-directory.ts
 */
async function main(): Promise<void> {
  const log = logger();
  const url = process.env["ADMIN_DATABASE_URL"];
  if (!url) {
    throw new Error("ADMIN_DATABASE_URL is required, and must point at the BYPASSRLS admin role");
  }

  const client = new PrismaClient({ datasources: { db: { url } } });

  try {
    const rows = await client.$executeRaw`
      INSERT INTO tenant_directory (client_id, slug, status, trading_name, timezone,
                                    meta_phone_number_id, meta_business_account_id,
                                    instagram_scoped_page_id, twilio_number, updated_at)
      SELECT c.id, c.slug, c.status, c.trading_name, c.timezone,
             cc.meta_phone_number_id, cc.meta_business_account_id,
             cc.instagram_scoped_page_id, cc.twilio_number, now()
        FROM clients c
        LEFT JOIN client_configurations cc ON cc.client_id = c.id
      ON CONFLICT (client_id) DO UPDATE
        SET slug = EXCLUDED.slug,
            status = EXCLUDED.status,
            trading_name = EXCLUDED.trading_name,
            timezone = EXCLUDED.timezone,
            meta_phone_number_id = EXCLUDED.meta_phone_number_id,
            meta_business_account_id = EXCLUDED.meta_business_account_id,
            instagram_scoped_page_id = EXCLUDED.instagram_scoped_page_id,
            twilio_number = EXCLUDED.twilio_number,
            updated_at = now()
    `;
    log.info({ rows }, "tenant directory rebuilt");
  } finally {
    await client.$disconnect();
  }
}

main().catch((err: unknown) => {
  logger().fatal({ err }, "backfill failed");
  process.exit(1);
});

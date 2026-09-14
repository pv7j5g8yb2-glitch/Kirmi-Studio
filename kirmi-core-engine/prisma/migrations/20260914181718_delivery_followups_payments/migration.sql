-- CreateEnum
CREATE TYPE "FollowUpKind" AS ENUM ('QUOTE_NO_REPLY', 'HOLD_EXPIRING', 'MISSED_CALL', 'REACTIVATION');

-- CreateEnum
CREATE TYPE "FollowUpStatus" AS ENUM ('SCHEDULED', 'SENT', 'CANCELLED', 'FAILED');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "AuditEventType" ADD VALUE 'FOLLOW_UP_SENT';
ALTER TYPE "AuditEventType" ADD VALUE 'PAYMENT_LINK_ISSUED';
ALTER TYPE "AuditEventType" ADD VALUE 'MEDIA_SENT';

-- AlterEnum
ALTER TYPE "ChannelType" ADD VALUE 'SMS';

-- AlterTable
ALTER TABLE "client_configurations" ADD COLUMN     "follow_up_policy" JSONB NOT NULL DEFAULT '{}',
ADD COLUMN     "message_templates" JSONB NOT NULL DEFAULT '[]',
ADD COLUMN     "sms_fallback_enabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "twilio_account_sid" TEXT,
ADD COLUMN     "vehicle_photos_enabled" BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE "reservations" ADD COLUMN     "payment_link_sent_at" TIMESTAMPTZ(3),
ADD COLUMN     "payment_url" TEXT;

-- CreateTable
CREATE TABLE "follow_ups" (
    "id" UUID NOT NULL,
    "client_id" UUID NOT NULL,
    "conversation_id" UUID NOT NULL,
    "quote_id" UUID,
    "reservation_id" UUID,
    "kind" "FollowUpKind" NOT NULL,
    "status" "FollowUpStatus" NOT NULL DEFAULT 'SCHEDULED',
    "attempt" INTEGER NOT NULL DEFAULT 1,
    "due_at" TIMESTAMPTZ(3) NOT NULL,
    "template_name" TEXT,
    "sent_message_id" UUID,
    "sent_at" TIMESTAMPTZ(3),
    "cancelled_reason" TEXT,
    "last_error" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "follow_ups_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "follow_ups_client_id_status_due_at_idx" ON "follow_ups"("client_id", "status", "due_at");

-- CreateIndex
CREATE INDEX "follow_ups_client_id_conversation_id_status_idx" ON "follow_ups"("client_id", "conversation_id", "status");

-- AddForeignKey
ALTER TABLE "follow_ups" ADD CONSTRAINT "follow_ups_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "clients"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "follow_ups" ADD CONSTRAINT "follow_ups_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Tenant isolation for follow_ups
--
-- Every new tenant scoped table has to be enrolled explicitly. Migration 0002
-- looped over the tables that existed then; it cannot reach forward in time,
-- and a table that misses this block is readable by every client on the
-- platform with nothing in the logs to say so.
--
-- FORCE matters as much as ENABLE: without it the table owner, which is the
-- role that runs migrations and seeds, silently bypasses its own policy.
--
-- SELECT privileges come from the ALTER DEFAULT PRIVILEGES set in migration
-- 0002, so no GRANT is needed here. Unlike tenant_directory, this table holds
-- customer scoped rows and belongs firmly inside the policy.
-- ---------------------------------------------------------------------------
ALTER TABLE "follow_ups" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "follow_ups" FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "follow_ups"
  USING ("client_id" = kirmi_current_client_id())
  WITH CHECK ("client_id" = kirmi_current_client_id());

-- A follow up that is due but never picked up is a lost booking, so the
-- sweeper's query has to stay index driven as the table grows. The partial
-- index keeps it proportional to what is outstanding rather than to history.
CREATE INDEX "follow_ups_due_scheduled_idx"
  ON "follow_ups" ("due_at")
  WHERE ("status" = 'SCHEDULED');

COMMENT ON TABLE "follow_ups" IS
  'Scheduled second attempts at quiet customers. The conversion engine.';

-- ---------------------------------------------------------------------------
-- Make the break glass role actually work
--
-- kirmi_admin was created with BYPASSRLS in scripts/provision-roles.sql, and
-- that is the whole point of it: incident response and lawful erasure, where
-- somebody must be able to see across tenants. But BYPASSRLS only exempts a
-- role from row level security. It grants no table privileges of its own, and
-- nothing ever granted them, so every query from that role failed with
-- "permission denied for table clients".
--
-- The failure mode is the worst possible one. Nobody exercises break glass on
-- a quiet Tuesday; they reach for it during an incident, at which point they
-- discover the tool does not work. Found while seeding a development database,
-- which is a considerably better time to find it.
--
-- provision-roles.sql cannot do this, because it runs before any table exists.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kirmi_admin') THEN
    GRANT USAGE ON SCHEMA public TO kirmi_admin;
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO kirmi_admin;
    GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO kirmi_admin;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public
      GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO kirmi_admin;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public
      GRANT USAGE, SELECT ON SEQUENCES TO kirmi_admin;
  END IF;
END
$$;

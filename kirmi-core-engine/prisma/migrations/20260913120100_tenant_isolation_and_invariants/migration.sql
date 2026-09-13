-- ===========================================================================
-- Migration 0002: tenant isolation and the invariants Postgres enforces for us
--
-- Everything in this file exists because application code is fallible. A
-- forgotten WHERE clause, a service called with the wrong id, a new endpoint
-- written in a hurry: none of them can leak one client's data into another's
-- session, because the database refuses before the query returns.
--
-- Three layers, in order of how much they are trusted:
--   1. Row level security, FORCED, keyed on a transaction local setting.
--   2. Declarative constraints: no overlapping holds, no backwards rentals.
--   3. An append only ledger, guarded by a trigger.
-- ===========================================================================

-- btree_gist lets a GiST exclusion constraint mix an equality column (uuid)
-- with a range column (tstzrange). Without it the overlap guard below cannot
-- be expressed declaratively.
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- ---------------------------------------------------------------------------
-- The tenant key
--
-- Reads the transaction local setting the connection middleware writes with
-- SET LOCAL / set_config(..., true). Returns NULL when nothing has been set,
-- and NULL compares to nothing, so an unscoped connection sees zero rows
-- rather than every row. The failure mode is an empty result, never a leak.
--
-- STABLE, not IMMUTABLE: the value changes between transactions, and marking
-- it IMMUTABLE would let the planner cache one tenant's id into a plan reused
-- by another tenant. That single word is load bearing.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION kirmi_current_client_id()
RETURNS uuid
LANGUAGE sql
STABLE
AS $$
  SELECT NULLIF(current_setting('app.current_client_id', true), '')::uuid;
$$;

COMMENT ON FUNCTION kirmi_current_client_id() IS
  'Active tenant for this transaction. NULL when unscoped, which denies everything.';

-- ---------------------------------------------------------------------------
-- Row level security
--
-- ENABLE turns policies on for everyone except the table owner. FORCE removes
-- that exemption, so the role that owns the tables and runs the migrations is
-- just as confined as the application role. Deliberately there is NO bypass
-- setting: a GUC that switches isolation off is precisely the switch an
-- injected statement would reach for. Break glass access is a separate role
-- carrying the BYPASSRLS attribute, provisioned outside the request path.
-- ---------------------------------------------------------------------------

-- The tenant root. A client can see exactly one row: its own.
ALTER TABLE "clients" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "clients" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "clients"
  USING ("id" = kirmi_current_client_id())
  WITH CHECK ("id" = kirmi_current_client_id());

-- Every other tenant owned table is keyed on client_id. USING filters what can
-- be read, updated or deleted; WITH CHECK filters what can be written, which
-- is what stops a tenant inserting a row stamped with someone else's id.
DO $$
DECLARE
  t text;
  tenant_tables text[] := ARRAY[
    'client_configurations',
    'client_api_keys',
    'customers',
    'customer_identities',
    'vehicle_categories',
    'vehicles',
    'conversations',
    'messages',
    'quotes',
    'reservations',
    'escalations',
    'webhook_events',
    'platform_audit_logs'
  ];
BEGIN
  FOREACH t IN ARRAY tenant_tables LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I
         USING ("client_id" = kirmi_current_client_id())
         WITH CHECK ("client_id" = kirmi_current_client_id())', t);
  END LOOP;
END
$$;

-- ---------------------------------------------------------------------------
-- Inventory invariants
--
-- The reservation service takes SELECT ... FOR UPDATE NOWAIT on the vehicle
-- row before it writes, which is what makes concurrent attempts sequential and
-- gives the loser a fast, clean rejection. This constraint is the second line:
-- if any future code path forgets that lock, the write still cannot land.
--
-- '[)' is half open on purpose. A car returned at 10:00 and collected again at
-- 10:00 is one handover, not an overlap.
-- ---------------------------------------------------------------------------
ALTER TABLE "reservations"
  ADD CONSTRAINT "reservations_no_overlapping_active_window"
  EXCLUDE USING gist (
    "vehicle_id" WITH =,
    tstzrange("start_at", "end_at", '[)') WITH &&
  )
  WHERE ("status" IN ('HOLD', 'CONFIRMED'));

COMMENT ON CONSTRAINT "reservations_no_overlapping_active_window" ON "reservations" IS
  'Belt to the row lock braces: a vehicle cannot carry two live claims over one window.';

-- A rental that ends before it starts prices as a negative and reads as free.
ALTER TABLE "reservations"
  ADD CONSTRAINT "reservations_window_is_forward" CHECK ("end_at" > "start_at");
ALTER TABLE "quotes"
  ADD CONSTRAINT "quotes_window_is_forward" CHECK ("end_at" > "start_at");
ALTER TABLE "quotes"
  ADD CONSTRAINT "quotes_duration_is_positive" CHECK ("duration_days" >= 1);

-- Money is an unsigned count of minor units. A negative total is either a bug
-- or a refund, and refunds are their own event, not a negative sale.
ALTER TABLE "quotes"
  ADD CONSTRAINT "quotes_totals_non_negative" CHECK (
    "base_fare_minor" >= 0 AND "subtotal_minor" >= 0 AND
    "vat_minor" >= 0 AND "total_minor" >= 0 AND "deposit_minor" >= 0
  );
ALTER TABLE "reservations"
  ADD CONSTRAINT "reservations_totals_non_negative" CHECK (
    "total_minor" >= 0 AND "paid_minor" >= 0 AND "deposit_minor" >= 0
  );
ALTER TABLE "vehicles"
  ADD CONSTRAINT "vehicles_rates_non_negative" CHECK (
    "daily_rate_minor" >= 0
    AND ("weekly_rate_minor" IS NULL OR "weekly_rate_minor" >= 0)
    AND ("monthly_rate_minor" IS NULL OR "monthly_rate_minor" >= 0)
  );

-- A hold without an expiry is a car withdrawn from sale forever.
ALTER TABLE "reservations"
  ADD CONSTRAINT "reservations_hold_has_expiry" CHECK (
    "status" <> 'HOLD' OR "hold_expires_at" IS NOT NULL
  );

-- One live thread per customer per channel. Two open conversations on the same
-- WhatsApp number means two agents answering the same person.
CREATE UNIQUE INDEX "conversations_one_open_per_identity"
  ON "conversations" ("client_id", "customer_id", "channel")
  WHERE "closed_at" IS NULL;

-- Sweeping expired holds is a hot path for the queue worker.
CREATE INDEX "reservations_expiring_holds"
  ON "reservations" ("hold_expires_at")
  WHERE "status" = 'HOLD';

-- ---------------------------------------------------------------------------
-- The ledger is append only
--
-- Client invoices are replayed from platform_audit_logs. If a row there can be
-- edited after the fact then the invoice is an assertion rather than evidence,
-- and the first billing dispute is unwinnable. Purging for a lawful erasure
-- request means the owner explicitly disabling this trigger, which is a
-- deliberate, visible act rather than a stray UPDATE.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION kirmi_reject_ledger_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'platform_audit_logs is append only, % rejected', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

CREATE TRIGGER "platform_audit_logs_append_only"
  BEFORE UPDATE OR DELETE ON "platform_audit_logs"
  FOR EACH STATEMENT
  EXECUTE FUNCTION kirmi_reject_ledger_mutation();

-- ---------------------------------------------------------------------------
-- Privileges for the application role
--
-- The app role reads and writes rows and nothing else. No DDL, no ownership,
-- and critically no BYPASSRLS. Skipped silently when the role is absent, so
-- this migration still applies on a laptop running a single superuser.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kirmi_app') THEN
    GRANT USAGE ON SCHEMA public TO kirmi_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO kirmi_app;
    GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO kirmi_app;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public
      GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO kirmi_app;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public
      GRANT USAGE, SELECT ON SEQUENCES TO kirmi_app;
  END IF;
END
$$;

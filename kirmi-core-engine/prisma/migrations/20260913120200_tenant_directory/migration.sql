-- ===========================================================================
-- Migration 0003: the routing projection
--
-- A webhook from Meta identifies its destination by phone_number_id. A webhook
-- from Twilio identifies it by the called number. Neither carries a clientId,
-- and we cannot set app.current_client_id until we know which client it is, so
-- there has to be one readable table that answers "who is this for".
--
-- That table is this one, and it is kept deliberately boring: routing keys, a
-- trading name, a timezone. No customer data, no pricing, no credentials. It is
-- maintained by triggers rather than by application code, so it cannot drift
-- from the rows it projects, and the application is never granted write access
-- to it at all.
-- ===========================================================================

-- The table itself is created by migration 0001, alongside the rest of the
-- schema. What lives here is everything Prisma's datamodel cannot express: the
-- triggers that keep the projection honest, and the privileges that keep the
-- application out of it.

-- ---------------------------------------------------------------------------
-- Projection triggers
--
-- SECURITY DEFINER because the trigger fires inside a transaction scoped to one
-- tenant, and the projection row it maintains lives outside row level security.
-- search_path is pinned, which is the non negotiable half of SECURITY DEFINER:
-- without it, a caller who can create a schema earlier on the path can hijack
-- what this function resolves.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION kirmi_sync_tenant_directory()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    DELETE FROM tenant_directory WHERE client_id = OLD.id;
    RETURN OLD;
  END IF;

  INSERT INTO tenant_directory (client_id, slug, status, trading_name, timezone, updated_at)
  VALUES (NEW.id, NEW.slug, NEW.status, NEW.trading_name, NEW.timezone, now())
  ON CONFLICT (client_id) DO UPDATE
    SET slug = EXCLUDED.slug,
        status = EXCLUDED.status,
        trading_name = EXCLUDED.trading_name,
        timezone = EXCLUDED.timezone,
        updated_at = now();

  RETURN NEW;
END;
$$;

CREATE TRIGGER "clients_sync_directory"
  AFTER INSERT OR UPDATE OR DELETE ON "clients"
  FOR EACH ROW EXECUTE FUNCTION kirmi_sync_tenant_directory();

-- Channel identifiers live on the configuration row, so they need their own
-- trigger. A client configured before its directory row exists would lose the
-- update, so this one inserts a placeholder rather than silently skipping.
CREATE OR REPLACE FUNCTION kirmi_sync_tenant_directory_channels()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  UPDATE tenant_directory
     SET meta_phone_number_id = NEW.meta_phone_number_id,
         meta_business_account_id = NEW.meta_business_account_id,
         instagram_scoped_page_id = NEW.instagram_scoped_page_id,
         twilio_number = NEW.twilio_number,
         updated_at = now()
   WHERE client_id = NEW.client_id;

  IF NOT FOUND THEN
    INSERT INTO tenant_directory (
      client_id, slug, status, trading_name, timezone,
      meta_phone_number_id, meta_business_account_id, instagram_scoped_page_id, twilio_number, updated_at
    )
    SELECT c.id, c.slug, c.status, c.trading_name, c.timezone,
           NEW.meta_phone_number_id, NEW.meta_business_account_id,
           NEW.instagram_scoped_page_id, NEW.twilio_number, now()
      FROM clients c
     WHERE c.id = NEW.client_id
    ON CONFLICT (client_id) DO NOTHING;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER "client_configurations_sync_directory"
  AFTER INSERT OR UPDATE ON "client_configurations"
  FOR EACH ROW EXECUTE FUNCTION kirmi_sync_tenant_directory_channels();

-- No backfill statement here, and that absence is deliberate.
--
-- These three migrations apply together to an empty database, so there is
-- nothing to backfill on a normal install. And a backfill could not work here
-- anyway: FORCE ROW LEVEL SECURITY confines the migration role too, so a
-- SELECT over clients from inside this migration would legitimately return
-- zero rows and the backfill would silently do nothing, which is worse than
-- not having one. Applying 0003 to a database that already carries clients is
-- handled by scripts/backfill-tenant-directory.ts, run once by the break glass
-- role, which is a visible act rather than a quiet no-op.
--
-- From this point on the triggers above keep the projection current.

-- ---------------------------------------------------------------------------
-- Read only for the application
--
-- The REVOKE is the important half. Migration 0002 set ALTER DEFAULT PRIVILEGES
-- so that future tables are writable by the app role, which is right for every
-- table except this one. Without the revoke, that default silently grants the
-- app UPDATE on the routing table, and an application that can rewrite its own
-- routing table can point another tenant's WhatsApp number at itself.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kirmi_app') THEN
    REVOKE ALL ON "tenant_directory" FROM kirmi_app;
    GRANT SELECT ON "tenant_directory" TO kirmi_app;
  END IF;
END
$$;

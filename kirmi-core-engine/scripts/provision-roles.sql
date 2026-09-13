-- ===========================================================================
-- Database roles for the Kirmi core engine
--
-- Run once, as a superuser, before the first migration. Three roles, and the
-- separation between them is a security boundary rather than tidiness:
--
--   kirmi_migrate  owns the schema, runs migrations. No application traffic.
--   kirmi_app      serves every request. No DDL, and critically NOBYPASSRLS.
--   kirmi_admin    break glass. BYPASSRLS, for incident response and lawful
--                  erasure only. Never used by a running process.
--
-- The single most important line in this file is NOBYPASSRLS on kirmi_app. A
-- superuser or a BYPASSRLS role silently ignores every row level security
-- policy in migration 0002, so pointing the application at the wrong role
-- turns the entire isolation model off without a single error being logged.
--
--   psql "$SUPERUSER_URL" -v app_password=... -v migrate_password=... \
--        -v admin_password=... -f scripts/provision-roles.sql
-- ===========================================================================

\set ON_ERROR_STOP on

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kirmi_migrate') THEN
    CREATE ROLE kirmi_migrate LOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kirmi_app') THEN
    CREATE ROLE kirmi_app LOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kirmi_admin') THEN
    CREATE ROLE kirmi_admin LOGIN;
  END IF;
END
$$;

ALTER ROLE kirmi_migrate WITH PASSWORD :'migrate_password' NOSUPERUSER NOBYPASSRLS CREATEDB;
ALTER ROLE kirmi_app     WITH PASSWORD :'app_password'     NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
ALTER ROLE kirmi_admin   WITH PASSWORD :'admin_password'   NOSUPERUSER BYPASSRLS;

-- A statement timeout on the application role, set at the role level so it
-- survives a code path that forgets to set its own.
ALTER ROLE kirmi_app SET statement_timeout = '8s';
ALTER ROLE kirmi_app SET idle_in_transaction_session_timeout = '15s';

-- The admin role is audited by being inconvenient: no default search_path, and
-- a short timeout, so it is unsuitable for anything but deliberate work.
ALTER ROLE kirmi_admin SET statement_timeout = '30s';

COMMENT ON ROLE kirmi_app IS 'Application role. NOBYPASSRLS is load bearing: granting it would disable tenant isolation entirely.';
COMMENT ON ROLE kirmi_admin IS 'Break glass only. BYPASSRLS. Never configure a running service with this role.';

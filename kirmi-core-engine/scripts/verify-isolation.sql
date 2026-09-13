-- ===========================================================================
-- Isolation self check
--
-- Run against any environment, including production, to confirm the guarantee
-- still holds. It answers three questions that together are the whole model:
--
--   1. Is row level security enabled AND forced on every tenant table?
--   2. Does every one of those tables actually carry a policy?
--   3. Is the application role free of BYPASSRLS?
--
-- Any row returned by the first two queries, or a `t` in the third, is a hole.
--
--   psql "$DATABASE_URL" -f scripts/verify-isolation.sql
-- ===========================================================================

\echo '--- tables missing RLS or FORCE (any row here is a hole) ---'
SELECT c.relname AS table_name,
       c.relrowsecurity  AS rls_enabled,
       c.relforcerowsecurity AS rls_forced
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'public'
   AND c.relkind = 'r'
   AND c.relname NOT IN ('_prisma_migrations', 'tenant_directory')
   AND (c.relrowsecurity IS FALSE OR c.relforcerowsecurity IS FALSE)
 ORDER BY 1;

\echo ''
\echo '--- tables with RLS on but no policy (deny all, probably a mistake) ---'
SELECT c.relname AS table_name
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'public'
   AND c.relkind = 'r'
   AND c.relrowsecurity
   AND NOT EXISTS (SELECT 1 FROM pg_policies p WHERE p.schemaname = 'public' AND p.tablename = c.relname)
 ORDER BY 1;

\echo ''
\echo '--- roles carrying BYPASSRLS (kirmi_app must NOT appear) ---'
SELECT rolname, rolbypassrls, rolsuper
  FROM pg_roles
 WHERE rolname LIKE 'kirmi%'
 ORDER BY 1;

\echo ''
\echo '--- policy expressions in force ---'
SELECT tablename, policyname, qual AS using_expression
  FROM pg_policies
 WHERE schemaname = 'public'
 ORDER BY tablename;

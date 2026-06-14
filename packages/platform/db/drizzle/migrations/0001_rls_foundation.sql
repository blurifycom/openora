-- ADR-0018: Postgres Row-Level Security (RLS) tenant isolation.
--
-- This migration is HAND-AUTHORED (drizzle-kit does not emit policies/roles). It
-- enables + FORCES RLS on every tenant-scoped table and attaches a policy that
-- restricts visibility to the row's tenant, resolved from the GUC `app.tenant_id`.
-- The per-request app connection sets that GUC on a pinned client (leak-safe, see
-- tenant-connection.ts); system paths (relay/seed/migrations) use a BYPASSRLS role.
--
-- Tenant column is the quoted-camelCase "tenantId" (not snake_case) - matching the
-- existing Drizzle convention across all module schemas.
--
-- FORCE ROW LEVEL SECURITY makes the policy apply even to the table OWNER, so RLS
-- is enforced and testable in local/CI setups that run a single superuser role.

--> statement-breakpoint

-- Two roles. Idempotent, guarded so re-running (or running on a managed Postgres
-- where role creation needs privileges) is safe. NOLOGIN by default - operators
-- attach a password / LOGIN and point DATABASE_URL / DATABASE_ADMIN_URL at them.
--
--  oss_app    : RLS-ENFORCED app role for per-request traffic. NOT superuser,
--               NOT BYPASSRLS - RLS applies to it.
--  oss_system : BYPASSRLS system role for the outbox relay, seed, migrations, and
--               any sanctioned cross-tenant admin query.
-- IMPORTANT: superusers and BYPASSRLS roles ALWAYS bypass RLS - even with FORCE.
-- So `oss_app` MUST be a plain, non-superuser, non-BYPASSRLS role for the policy to
-- bite. In production, point DATABASE_URL at oss_app with an operator-set password.
--
-- oss_app is given LOGIN + a DEV-ONLY default password here so the integration test
-- (and local `pnpm dev`) can connect as a genuinely RLS-enforced role on a fresh
-- single-superuser Postgres. Operators MUST rotate this password (ALTER ROLE oss_app
-- PASSWORD '...') before any non-local deployment - it is not a secret.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'oss_app') THEN
    CREATE ROLE oss_app LOGIN PASSWORD 'oss_app_dev';
  ELSE
    ALTER ROLE oss_app LOGIN NOSUPERUSER NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'oss_system') THEN
    CREATE ROLE oss_system NOLOGIN BYPASSRLS;
  ELSE
    ALTER ROLE oss_system BYPASSRLS;
  END IF;
END
$$;--> statement-breakpoint

-- Grant the app + system roles access to the current schema's tables/sequences.
-- (RLS still constrains row visibility for oss_app; oss_system bypasses it.)
GRANT USAGE ON SCHEMA public TO oss_app, oss_system;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO oss_app, oss_system;--> statement-breakpoint
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO oss_app, oss_system;--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO oss_app, oss_system;--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO oss_app, oss_system;--> statement-breakpoint

-- Helper applied per table below (inlined - migrations are plain SQL):
--   ENABLE + FORCE RLS, then a single FOR ALL policy keyed on the tenant GUC.
--   USING governs read/update/delete visibility; WITH CHECK governs insert/update
--   writes - both require tenantId to equal the request's app.tenant_id. Using the
--   `true` (missing_ok) form of current_setting returns NULL when the GUC is unset,
--   so a connection with no tenant set sees ZERO rows (fail-closed) rather than erroring.

-- event_outbox: tenantId is NULLABLE (system-written envelopes may have no tenant).
-- The policy lets the row through when its tenant matches the GUC OR when tenantId
-- is NULL (system events), so the relay (which runs as oss_system / BYPASSRLS reads
-- everything anyway) and per-tenant writers both behave correctly.
ALTER TABLE "event_outbox" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "event_outbox" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "event_outbox_tenant_isolation" ON "event_outbox" FOR ALL
  USING ("tenantId" IS NULL OR "tenantId" = current_setting('app.tenant_id', true))
  WITH CHECK ("tenantId" IS NULL OR "tenantId" = current_setting('app.tenant_id', true));

--> statement-breakpoint

-- audit_log
ALTER TABLE "audit_log" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "audit_log" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'audit_log'
      AND policyname = 'audit_log_tenant_isolation'
  ) THEN
    CREATE POLICY "audit_log_tenant_isolation" ON "audit_log" FOR ALL
      USING ("tenantId" = current_setting('app.tenant_id', true))
      WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));
  END IF;
END
$$;

--> statement-breakpoint

DROP POLICY IF EXISTS "audit_log_tenant_isolation" ON "audit_log";--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'audit_log'
      AND policyname = 'audit_log_tenant_select'
  ) THEN
    CREATE POLICY "audit_log_tenant_select" ON "audit_log" FOR SELECT
      USING ("tenantId" = current_setting('app.tenant_id', true));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'audit_log'
      AND policyname = 'audit_log_tenant_insert'
  ) THEN
    CREATE POLICY "audit_log_tenant_insert" ON "audit_log" FOR INSERT
      WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));
  END IF;
END
$$;--> statement-breakpoint

-- 2. Belt-and-braces: REVOKE UPDATE/DELETE from the runtime role outright, so even
--    if a future policy widened access the role still cannot mutate audit rows.
--    SELECT/INSERT are explicitly granted (idempotent re-grant).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'oss_app') THEN
    REVOKE UPDATE, DELETE, TRUNCATE ON "audit_log" FROM oss_app;
    GRANT SELECT, INSERT ON "audit_log" TO oss_app;
  END IF;
END
$$;

-- ADR-0018 / audit tamper-evidence: enforce APPEND-ONLY on "audit_log" at the DB
-- layer for the RLS-enforced runtime role (oss_app).
--
-- This migration is HAND-AUTHORED (drizzle-kit does not emit policies/grants).
-- Background: migration 0006 GRANTed SELECT/INSERT/UPDATE/DELETE on all tables to
-- oss_app, and 0011 attached a single `FOR ALL` tenant-isolation policy to
-- audit_log - together those PERMIT UPDATE/DELETE. Regulators (MGA/UKGC) and
-- audit-log best practice require the runtime role to be able to append (INSERT)
-- and read (SELECT) only, never to mutate or remove existing entries. The
-- application write path (AuditService.record) performs a single INSERT and no
-- UPDATE, so revoking UPDATE/DELETE does NOT break it.
--
-- The migration owner/admin role (and oss_system / BYPASSRLS) retain full rights,
-- which are needed for retention, partition maintenance, and lawful purges.
--
-- Idempotent: guarded with IF EXISTS / pg_policies checks so re-running is safe.

--> statement-breakpoint

-- 1. Replace the broad FOR ALL tenant-isolation policy with separate SELECT and
--    INSERT policies. Dropping FOR ALL removes the implicit UPDATE/DELETE grant
--    the policy gave; the new policies keep tenant isolation on read + write.
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

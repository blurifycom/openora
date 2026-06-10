-- ADR-0018: auto-generated RLS tenant-isolation policies for newly added tables.
-- Emitted by tools/gen-rls.ts during `pnpm regen` (drizzle-kit does not emit
-- policies). Idempotent: ENABLE/FORCE are no-ops if set; the policy is created
-- only when absent. Runs under the migration owner/admin role, not oss_app.
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

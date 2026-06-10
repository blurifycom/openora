-- ADR-0018: auto-generated RLS tenant-isolation policies for newly added tables.
-- Emitted by tools/gen-rls.ts during `pnpm regen` (drizzle-kit does not emit
-- policies). Idempotent: ENABLE/FORCE are no-ops if set; the policy is created
-- only when absent. Runs under the migration owner/admin role, not oss_app.
-- admin_role_permission
ALTER TABLE "admin_role_permission" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "admin_role_permission" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'admin_role_permission'
      AND policyname = 'admin_role_permission_tenant_isolation'
  ) THEN
    CREATE POLICY "admin_role_permission_tenant_isolation" ON "admin_role_permission" FOR ALL
      USING ("tenantId" = current_setting('app.tenant_id', true))
      WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));
  END IF;
END
$$;

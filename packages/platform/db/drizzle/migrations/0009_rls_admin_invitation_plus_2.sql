-- ADR-0018: auto-generated RLS tenant-isolation policies for newly added tables.
-- Emitted by tools/gen-rls.ts during `pnpm regen` (drizzle-kit does not emit
-- policies). Idempotent: ENABLE/FORCE are no-ops if set; the policy is created
-- only when absent. Runs under the migration owner/admin role, not oss_app.
-- admin_invitation
ALTER TABLE "admin_invitation" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "admin_invitation" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'admin_invitation'
      AND policyname = 'admin_invitation_tenant_isolation'
  ) THEN
    CREATE POLICY "admin_invitation_tenant_isolation" ON "admin_invitation" FOR ALL
      USING ("tenantId" = current_setting('app.tenant_id', true))
      WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));
  END IF;
END
$$;
--> statement-breakpoint

-- admin_role
ALTER TABLE "admin_role" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "admin_role" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'admin_role'
      AND policyname = 'admin_role_tenant_isolation'
  ) THEN
    CREATE POLICY "admin_role_tenant_isolation" ON "admin_role" FOR ALL
      USING ("tenantId" = current_setting('app.tenant_id', true))
      WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));
  END IF;
END
$$;
--> statement-breakpoint

-- admin_role_assignment
ALTER TABLE "admin_role_assignment" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "admin_role_assignment" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'admin_role_assignment'
      AND policyname = 'admin_role_assignment_tenant_isolation'
  ) THEN
    CREATE POLICY "admin_role_assignment_tenant_isolation" ON "admin_role_assignment" FOR ALL
      USING ("tenantId" = current_setting('app.tenant_id', true))
      WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));
  END IF;
END
$$;

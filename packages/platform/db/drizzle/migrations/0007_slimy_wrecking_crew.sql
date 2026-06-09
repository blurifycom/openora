ALTER TABLE "user_limit" ADD COLUMN "tenantId" text DEFAULT 'default' NOT NULL;--> statement-breakpoint
ALTER TABLE "notification" ADD COLUMN "tenantId" text DEFAULT 'default' NOT NULL;--> statement-breakpoint
CREATE INDEX "user_limit_tenantId_idx" ON "user_limit" USING btree ("tenantId");--> statement-breakpoint
CREATE INDEX "notification_tenantId_idx" ON "notification" USING btree ("tenantId");--> statement-breakpoint

-- ADR-0018 (follow-up to 0006): two tenant-scoped tables shipped without a
-- tenantId and so without RLS - a silent cross-tenant leak of responsible-gaming
-- / AML limits and notification PII. The columns are added above; the same
-- ENABLE + FORCE RLS + tenant-isolation policy 0006 applies to every scoped table
-- is hand-authored here (drizzle-kit does not emit policies). Idempotent: the
-- ENABLE/FORCE are no-ops if already set and the policy is created only when absent.
-- These run under the migration's owner/admin role (DATABASE_ADMIN_URL), not oss_app.

-- user_limit (responsible-gaming / AML limits)
ALTER TABLE "user_limit" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "user_limit" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'user_limit'
      AND policyname = 'user_limit_tenant_isolation'
  ) THEN
    CREATE POLICY "user_limit_tenant_isolation" ON "user_limit" FOR ALL
      USING ("tenantId" = current_setting('app.tenant_id', true))
      WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));
  END IF;
END
$$;--> statement-breakpoint

-- notification (PII: title / body)
ALTER TABLE "notification" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "notification" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'notification'
      AND policyname = 'notification_tenant_isolation'
  ) THEN
    CREATE POLICY "notification_tenant_isolation" ON "notification" FOR ALL
      USING ("tenantId" = current_setting('app.tenant_id', true))
      WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));
  END IF;
END
$$;
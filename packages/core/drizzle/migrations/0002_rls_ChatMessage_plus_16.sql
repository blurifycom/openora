-- ADR-0018: auto-generated RLS tenant-isolation policies for newly added tables.
-- Emitted by tools/gen-rls.ts during `pnpm regen` (drizzle-kit does not emit
-- policies). Idempotent: ENABLE/FORCE are no-ops if set; the policy is created
-- only when absent. Runs under the migration owner/admin role, not oss_app.
-- ChatMessage
ALTER TABLE "ChatMessage" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "ChatMessage" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'ChatMessage'
      AND policyname = 'ChatMessage_tenant_isolation'
  ) THEN
    CREATE POLICY "ChatMessage_tenant_isolation" ON "ChatMessage" FOR ALL
      USING ("tenantId" = current_setting('app.tenant_id', true))
      WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));
  END IF;
END
$$;
--> statement-breakpoint

-- ChatRoom
ALTER TABLE "ChatRoom" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "ChatRoom" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'ChatRoom'
      AND policyname = 'ChatRoom_tenant_isolation'
  ) THEN
    CREATE POLICY "ChatRoom_tenant_isolation" ON "ChatRoom" FOR ALL
      USING ("tenantId" = current_setting('app.tenant_id', true))
      WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));
  END IF;
END
$$;
--> statement-breakpoint

-- FeaturedSlot
ALTER TABLE "FeaturedSlot" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "FeaturedSlot" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'FeaturedSlot'
      AND policyname = 'FeaturedSlot_tenant_isolation'
  ) THEN
    CREATE POLICY "FeaturedSlot_tenant_isolation" ON "FeaturedSlot" FOR ALL
      USING ("tenantId" = current_setting('app.tenant_id', true))
      WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));
  END IF;
END
$$;
--> statement-breakpoint

-- Game
ALTER TABLE "Game" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "Game" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'Game'
      AND policyname = 'Game_tenant_isolation'
  ) THEN
    CREATE POLICY "Game_tenant_isolation" ON "Game" FOR ALL
      USING ("tenantId" = current_setting('app.tenant_id', true))
      WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));
  END IF;
END
$$;
--> statement-breakpoint

-- GameRound
ALTER TABLE "GameRound" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "GameRound" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'GameRound'
      AND policyname = 'GameRound_tenant_isolation'
  ) THEN
    CREATE POLICY "GameRound_tenant_isolation" ON "GameRound" FOR ALL
      USING ("tenantId" = current_setting('app.tenant_id', true))
      WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));
  END IF;
END
$$;
--> statement-breakpoint

-- LobbyCategory
ALTER TABLE "LobbyCategory" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "LobbyCategory" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'LobbyCategory'
      AND policyname = 'LobbyCategory_tenant_isolation'
  ) THEN
    CREATE POLICY "LobbyCategory_tenant_isolation" ON "LobbyCategory" FOR ALL
      USING ("tenantId" = current_setting('app.tenant_id', true))
      WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));
  END IF;
END
$$;
--> statement-breakpoint

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
--> statement-breakpoint

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
--> statement-breakpoint

-- bonus
ALTER TABLE "bonus" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "bonus" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'bonus'
      AND policyname = 'bonus_tenant_isolation'
  ) THEN
    CREATE POLICY "bonus_tenant_isolation" ON "bonus" FOR ALL
      USING ("tenantId" = current_setting('app.tenant_id', true))
      WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));
  END IF;
END
$$;
--> statement-breakpoint

-- notification
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
--> statement-breakpoint

-- player
ALTER TABLE "player" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "player" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'player'
      AND policyname = 'player_tenant_isolation'
  ) THEN
    CREATE POLICY "player_tenant_isolation" ON "player" FOR ALL
      USING ("tenantId" = current_setting('app.tenant_id', true))
      WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));
  END IF;
END
$$;
--> statement-breakpoint

-- user_bonus
ALTER TABLE "user_bonus" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "user_bonus" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'user_bonus'
      AND policyname = 'user_bonus_tenant_isolation'
  ) THEN
    CREATE POLICY "user_bonus_tenant_isolation" ON "user_bonus" FOR ALL
      USING ("tenantId" = current_setting('app.tenant_id', true))
      WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));
  END IF;
END
$$;
--> statement-breakpoint

-- user_limit
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
$$;
--> statement-breakpoint

-- wallet
ALTER TABLE "wallet" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "wallet" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'wallet'
      AND policyname = 'wallet_tenant_isolation'
  ) THEN
    CREATE POLICY "wallet_tenant_isolation" ON "wallet" FOR ALL
      USING ("tenantId" = current_setting('app.tenant_id', true))
      WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));
  END IF;
END
$$;
--> statement-breakpoint

-- wallet_transaction
ALTER TABLE "wallet_transaction" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "wallet_transaction" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'wallet_transaction'
      AND policyname = 'wallet_transaction_tenant_isolation'
  ) THEN
    CREATE POLICY "wallet_transaction_tenant_isolation" ON "wallet_transaction" FOR ALL
      USING ("tenantId" = current_setting('app.tenant_id', true))
      WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));
  END IF;
END
$$;

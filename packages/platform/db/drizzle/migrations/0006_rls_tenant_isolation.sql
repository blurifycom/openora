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

-- wallet
ALTER TABLE "wallet" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "wallet" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "wallet_tenant_isolation" ON "wallet" FOR ALL
  USING ("tenantId" = current_setting('app.tenant_id', true))
  WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));--> statement-breakpoint

-- wallet_transaction
ALTER TABLE "wallet_transaction" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "wallet_transaction" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "wallet_transaction_tenant_isolation" ON "wallet_transaction" FOR ALL
  USING ("tenantId" = current_setting('app.tenant_id', true))
  WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));--> statement-breakpoint

-- player
ALTER TABLE "player" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "player" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "player_tenant_isolation" ON "player" FOR ALL
  USING ("tenantId" = current_setting('app.tenant_id', true))
  WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));--> statement-breakpoint

-- bonus
ALTER TABLE "bonus" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "bonus" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "bonus_tenant_isolation" ON "bonus" FOR ALL
  USING ("tenantId" = current_setting('app.tenant_id', true))
  WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));--> statement-breakpoint

-- user_bonus
ALTER TABLE "user_bonus" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "user_bonus" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "user_bonus_tenant_isolation" ON "user_bonus" FOR ALL
  USING ("tenantId" = current_setting('app.tenant_id', true))
  WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));--> statement-breakpoint

-- Game
ALTER TABLE "Game" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "Game" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "Game_tenant_isolation" ON "Game" FOR ALL
  USING ("tenantId" = current_setting('app.tenant_id', true))
  WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));--> statement-breakpoint

-- GameRound
ALTER TABLE "GameRound" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "GameRound" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "GameRound_tenant_isolation" ON "GameRound" FOR ALL
  USING ("tenantId" = current_setting('app.tenant_id', true))
  WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));--> statement-breakpoint

-- ChatRoom
ALTER TABLE "ChatRoom" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "ChatRoom" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "ChatRoom_tenant_isolation" ON "ChatRoom" FOR ALL
  USING ("tenantId" = current_setting('app.tenant_id', true))
  WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));--> statement-breakpoint

-- ChatMessage
ALTER TABLE "ChatMessage" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "ChatMessage" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "ChatMessage_tenant_isolation" ON "ChatMessage" FOR ALL
  USING ("tenantId" = current_setting('app.tenant_id', true))
  WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));--> statement-breakpoint

-- aggregator_provider
ALTER TABLE "aggregator_provider" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "aggregator_provider" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "aggregator_provider_tenant_isolation" ON "aggregator_provider" FOR ALL
  USING ("tenantId" = current_setting('app.tenant_id', true))
  WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));--> statement-breakpoint

-- LobbyCategory
ALTER TABLE "LobbyCategory" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "LobbyCategory" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "LobbyCategory_tenant_isolation" ON "LobbyCategory" FOR ALL
  USING ("tenantId" = current_setting('app.tenant_id', true))
  WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));--> statement-breakpoint

-- FeaturedSlot
ALTER TABLE "FeaturedSlot" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "FeaturedSlot" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "FeaturedSlot_tenant_isolation" ON "FeaturedSlot" FOR ALL
  USING ("tenantId" = current_setting('app.tenant_id', true))
  WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));--> statement-breakpoint

-- leaderboard
ALTER TABLE "leaderboard" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "leaderboard" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "leaderboard_tenant_isolation" ON "leaderboard" FOR ALL
  USING ("tenantId" = current_setting('app.tenant_id', true))
  WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));--> statement-breakpoint

-- leaderboard_entry
ALTER TABLE "leaderboard_entry" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "leaderboard_entry" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "leaderboard_entry_tenant_isolation" ON "leaderboard_entry" FOR ALL
  USING ("tenantId" = current_setting('app.tenant_id', true))
  WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));--> statement-breakpoint

-- SportsbookEvent
ALTER TABLE "SportsbookEvent" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "SportsbookEvent" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "SportsbookEvent_tenant_isolation" ON "SportsbookEvent" FOR ALL
  USING ("tenantId" = current_setting('app.tenant_id', true))
  WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));--> statement-breakpoint

-- SportsbookBet
ALTER TABLE "SportsbookBet" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "SportsbookBet" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "SportsbookBet_tenant_isolation" ON "SportsbookBet" FOR ALL
  USING ("tenantId" = current_setting('app.tenant_id', true))
  WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));--> statement-breakpoint

-- event_outbox: tenantId is NULLABLE (system-written envelopes may have no tenant).
-- The policy lets the row through when its tenant matches the GUC OR when tenantId
-- is NULL (system events), so the relay (which runs as oss_system / BYPASSRLS reads
-- everything anyway) and per-tenant writers both behave correctly.
ALTER TABLE "event_outbox" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "event_outbox" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "event_outbox_tenant_isolation" ON "event_outbox" FOR ALL
  USING ("tenantId" IS NULL OR "tenantId" = current_setting('app.tenant_id', true))
  WITH CHECK ("tenantId" IS NULL OR "tenantId" = current_setting('app.tenant_id', true));

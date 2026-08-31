CREATE TYPE "public"."limit_change_kind" AS ENUM('increase', 'removal');--> statement-breakpoint
DROP INDEX "user_limit_user_id_type_period_key";--> statement-breakpoint
ALTER TABLE "user_limit" ALTER COLUMN "amount" SET DATA TYPE numeric(38, 18);--> statement-breakpoint
ALTER TABLE "user_limit" ADD COLUMN "currency" text;--> statement-breakpoint
-- The session-type limit is measured in minutes, not money, so it always carries the
-- SESSION_LIMIT_CURRENCY sentinel (see schema/index.ts) - there is no player-currency
-- question for it, and a sentinel rather than NULL keeps it inside the uniqueness check
-- below.
UPDATE "user_limit"
SET "currency" = 'SESSION'
WHERE "type" = 'session' AND "currency" IS NULL;--> statement-breakpoint
ALTER TABLE "user_limit" ADD COLUMN "pending_kind" "limit_change_kind";--> statement-breakpoint
ALTER TABLE "user_limit" ADD COLUMN "pending_amount" numeric(38, 18);--> statement-breakpoint
ALTER TABLE "user_limit" ADD COLUMN "pending_minutes" integer;--> statement-breakpoint
ALTER TABLE "user_limit" ADD COLUMN "pending_currency" text;--> statement-breakpoint
ALTER TABLE "user_limit" ADD COLUMN "pending_requested_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "user_limit" ADD COLUMN "pending_effective_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "user_limit" ADD COLUMN "pending_expires_at" timestamp with time zone;--> statement-breakpoint
-- A pre-existing MONEY-type row is deliberately left NULL rather than backfilled. It is
-- resolved to the player's own currency, once, the first time anything touches it (see
-- resolveLimitCurrency in service/rg.service.ts). A blanket backfill would silently
-- redefine a limit the player themselves chose: a 100,000 JPY deposit limit (~$650)
-- rewritten to 100,000 USD is not the same protection. NULL here means "not yet
-- resolved", never "no currency".
--
-- NULL is safe in the widened unique index even though Postgres treats every NULL as
-- distinct: a NULL can only come from a pre-existing row, and the old
-- (user_id, type, period) index already allowed at most one of those per slot, so there
-- is nothing to duplicate. The row joins the uniqueness check for real once resolved.
CREATE UNIQUE INDEX "user_limit_user_id_type_period_currency_key" ON "user_limit" USING btree ("user_id","type","period","currency");--> statement-breakpoint
CREATE INDEX "user_limit_pending_expires_at_idx" ON "user_limit" USING btree ("pending_expires_at");
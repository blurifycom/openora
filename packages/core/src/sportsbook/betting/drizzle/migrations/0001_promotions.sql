CREATE TYPE "public"."sportsbook_promotion_funder" AS ENUM('operator', 'provider');--> statement-breakpoint
ALTER TYPE "public"."sportsbook_finding_kind" ADD VALUE 'promotion_payout_unusual';--> statement-breakpoint
ALTER TABLE "sportsbook_bet" ADD COLUMN "cash_stake" numeric(38, 18);--> statement-breakpoint
ALTER TABLE "sportsbook_bet" ADD COLUMN "void_payout" numeric(38, 18);--> statement-breakpoint
UPDATE "sportsbook_bet" SET "cash_stake" = "stake", "void_payout" = "stake";--> statement-breakpoint
ALTER TABLE "sportsbook_bet" ALTER COLUMN "cash_stake" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "sportsbook_bet" ALTER COLUMN "void_payout" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "sportsbook_bet" ADD COLUMN "max_loss_refund" numeric(38, 18) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "sportsbook_bet" ADD COLUMN "promotion_type" text;--> statement-breakpoint
ALTER TABLE "sportsbook_bet" ADD COLUMN "promotion_id" text;--> statement-breakpoint
ALTER TABLE "sportsbook_bet" ADD COLUMN "promotion_funder" "sportsbook_promotion_funder";--> statement-breakpoint
ALTER TABLE "sportsbook_bet" ADD COLUMN "promotion_potential" numeric(38, 18);--> statement-breakpoint
ALTER TABLE "sportsbook_bet" ADD COLUMN "promotion_paid" numeric(38, 18) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "sportsbook_bet_transaction" ADD COLUMN "promotion_potential" numeric(38, 18);--> statement-breakpoint
ALTER TABLE "sportsbook_bet_transaction" ADD COLUMN "promotion_amount" numeric(38, 18);--> statement-breakpoint
ALTER TABLE "sportsbook_config" ADD COLUMN "promotions" jsonb DEFAULT '{"enabled":false,"maxPromotionStakeUsd":null,"funder":{}}'::jsonb NOT NULL;--> statement-breakpoint
CREATE INDEX "sportsbook_bet_transaction_promotion_created_at_idx" ON "sportsbook_bet_transaction" USING btree ("created_at") WHERE "sportsbook_bet_transaction"."promotion_amount" > 0;--> statement-breakpoint
ALTER TABLE "sportsbook_bet" ADD CONSTRAINT "sportsbook_bet_cash_stake_check" CHECK ("sportsbook_bet"."cash_stake" IN (0, "sportsbook_bet"."stake") AND ("sportsbook_bet"."cash_stake" = "sportsbook_bet"."stake" OR "sportsbook_bet"."promotion_type" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "sportsbook_bet" ADD CONSTRAINT "sportsbook_bet_void_payout_check" CHECK ("sportsbook_bet"."void_payout" IN (0, "sportsbook_bet"."stake") AND ("sportsbook_bet"."cash_stake" = 0 OR "sportsbook_bet"."void_payout" = "sportsbook_bet"."stake"));--> statement-breakpoint
ALTER TABLE "sportsbook_bet" ADD CONSTRAINT "sportsbook_bet_max_loss_refund_check" CHECK ("sportsbook_bet"."max_loss_refund" IN (0, "sportsbook_bet"."cash_stake") AND ("sportsbook_bet"."max_loss_refund" = 0 OR "sportsbook_bet"."promotion_type" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "sportsbook_bet" ADD CONSTRAINT "sportsbook_bet_promotion_paid_check" CHECK ("sportsbook_bet"."promotion_paid" >= 0 AND "sportsbook_bet"."promotion_paid" <= "sportsbook_bet"."payout_total" AND ("sportsbook_bet"."promotion_paid" = 0 OR "sportsbook_bet"."promotion_type" IS NOT NULL) AND ("sportsbook_bet"."cash_stake" > 0 OR "sportsbook_bet"."promotion_paid" = "sportsbook_bet"."payout_total"));--> statement-breakpoint
ALTER TABLE "sportsbook_bet" ADD CONSTRAINT "sportsbook_bet_promotion_funder_check" CHECK (("sportsbook_bet"."promotion_type" IS NULL) = ("sportsbook_bet"."promotion_funder" IS NULL));--> statement-breakpoint
ALTER TABLE "sportsbook_bet" ADD CONSTRAINT "sportsbook_bet_result_payout_check" CHECK (("sportsbook_bet"."result" IS DISTINCT FROM 'void' OR "sportsbook_bet"."payout_total" = "sportsbook_bet"."void_payout" OR ("sportsbook_bet"."cash_stake" = 0 AND "sportsbook_bet"."payout_total" = 0)) AND ("sportsbook_bet"."result" IS DISTINCT FROM 'lost' OR "sportsbook_bet"."payout_total" <= "sportsbook_bet"."max_loss_refund"));
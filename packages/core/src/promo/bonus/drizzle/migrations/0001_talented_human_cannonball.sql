CREATE TYPE "public"."promo_forfeit_reason" AS ENUM('self_exclusion', 'account_closed', 'admin', 'player_opt_out', 'withdrawal_while_active');--> statement-breakpoint
CREATE TYPE "public"."promo_grant_source" AS ENUM('deposit', 'manual', 'streak', 'rank', 'race', 'gift', 'rain');--> statement-breakpoint
CREATE TYPE "public"."promo_grant_status" AS ENUM('pending', 'active', 'completed', 'expired', 'forfeited', 'cancelled');--> statement-breakpoint
CREATE TABLE "promo_grant" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"currency" text NOT NULL,
	"source" "promo_grant_source" NOT NULL,
	"source_ref" text NOT NULL,
	"offer_id" uuid,
	"terms" jsonb NOT NULL,
	"granted_amount" numeric(38, 18) NOT NULL,
	"bonus_balance" numeric(38, 18) DEFAULT '0' NOT NULL,
	"wagering_required" numeric(38, 18) NOT NULL,
	"wagering_progress" numeric(38, 18) DEFAULT '0' NOT NULL,
	"status" "promo_grant_status" DEFAULT 'active' NOT NULL,
	"forfeit_reason" "promo_forfeit_reason",
	"expires_at" timestamp with time zone NOT NULL,
	"activated_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "promo_grant_bonus_balance_non_negative" CHECK ("promo_grant"."bonus_balance" >= 0),
	CONSTRAINT "promo_grant_progress_within_requirement" CHECK ("promo_grant"."wagering_progress" >= 0 AND "promo_grant"."wagering_progress" <= "promo_grant"."wagering_required"),
	CONSTRAINT "promo_grant_forfeit_reason_requires_forfeited" CHECK ("promo_grant"."forfeit_reason" is null or "promo_grant"."status" = 'forfeited')
);
--> statement-breakpoint
CREATE UNIQUE INDEX "promo_grant_user_id_source_source_ref_idx" ON "promo_grant" USING btree ("user_id","source","source_ref");--> statement-breakpoint
CREATE INDEX "promo_grant_user_id_currency_created_at_idx" ON "promo_grant" USING btree ("user_id","currency","created_at") WHERE "promo_grant"."status" in ('pending', 'active');--> statement-breakpoint
CREATE INDEX "promo_grant_expires_at_idx" ON "promo_grant" USING btree ("expires_at") WHERE "promo_grant"."status" = 'active';
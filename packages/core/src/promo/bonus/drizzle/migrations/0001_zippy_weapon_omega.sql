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
	"wagering_required" numeric(38, 18) NOT NULL,
	"wagering_progress" numeric(38, 18) DEFAULT '0' NOT NULL,
	"status" "promo_grant_status" DEFAULT 'active' NOT NULL,
	"forfeit_reason" "promo_forfeit_reason",
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "promo_grant_user_id_source_source_ref_index" ON "promo_grant" USING btree ("user_id","source","source_ref");--> statement-breakpoint
CREATE INDEX "promo_grant_user_id_currency_status_created_at_index" ON "promo_grant" USING btree ("user_id","currency","status","created_at");--> statement-breakpoint
CREATE INDEX "promo_grant_expires_at_index" ON "promo_grant" USING btree ("expires_at") WHERE "promo_grant"."status" = 'active';
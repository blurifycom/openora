CREATE TYPE "public"."promo_contribution_mode" AS ENUM('flat', 'house_edge');--> statement-breakpoint
ALTER TYPE "public"."promo_grant_entry_type" ADD VALUE 'progress';--> statement-breakpoint
ALTER TABLE "promo_grant_entry" ADD COLUMN "wager_inputs" jsonb;--> statement-breakpoint
ALTER TABLE "promo_grant_round" ADD COLUMN "progress_pending" numeric(38, 18) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "promo_weight_profile" ADD COLUMN "contribution_mode" "promo_contribution_mode" DEFAULT 'flat' NOT NULL;--> statement-breakpoint
ALTER TABLE "promo_weight_profile" ADD COLUMN "reference_edge" numeric(19, 18);--> statement-breakpoint
ALTER TABLE "promo_weight_profile" ADD COLUMN "version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
CREATE INDEX "promo_grant_round_round_key_idx" ON "promo_grant_round" USING btree ("user_id","currency","provider_name","external_round_id");--> statement-breakpoint
ALTER TABLE "promo_grant_round" ADD CONSTRAINT "promo_grant_round_progress_pending_non_negative" CHECK ("promo_grant_round"."progress_pending" >= 0);--> statement-breakpoint
ALTER TABLE "promo_weight_profile" ADD CONSTRAINT "promo_weight_profile_reference_edge_matches_mode" CHECK (("promo_weight_profile"."contribution_mode" = 'house_edge') = ("promo_weight_profile"."reference_edge" is not null) AND ("promo_weight_profile"."reference_edge" is null OR ("promo_weight_profile"."reference_edge" > 0 AND "promo_weight_profile"."reference_edge" <= 1)));
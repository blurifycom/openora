CREATE TYPE "public"."promo_streak_rakeback_mode" AS ENUM('unranked', 'ranked');--> statement-breakpoint
ALTER TABLE "promo_streak_config" ALTER COLUMN "currency" SET DEFAULT 'USD';--> statement-breakpoint
ALTER TABLE "promo_rakeback_accrual" ADD COLUMN "streak_mode" "promo_streak_rakeback_mode";--> statement-breakpoint
ALTER TABLE "promo_rakeback_accrual" ADD COLUMN "streak_percent" numeric(5, 2);--> statement-breakpoint
ALTER TABLE "promo_streak_config" ADD COLUMN "enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "promo_streak_config" ADD COLUMN "rakeback_milestones" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "promo_streak_config" ADD COLUMN "fixed_rewards" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "promo_streak_milestone_grant" ADD COLUMN "amount" numeric(38, 18);--> statement-breakpoint
ALTER TABLE "promo_streak_milestone_grant" ADD COLUMN "rollover_multiplier" numeric(38, 18);--> statement-breakpoint
ALTER TABLE "promo_streak_milestone_grant" ADD COLUMN "claim_expiry_days" integer;--> statement-breakpoint
ALTER TABLE "promo_streak_milestone_grant" ADD COLUMN "expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "promo_rakeback_accrual" ADD CONSTRAINT "promo_rakeback_accrual_streak" CHECK (("promo_rakeback_accrual"."streak_mode" is null) = ("promo_rakeback_accrual"."streak_percent" is null));--> statement-breakpoint
ALTER TABLE "promo_streak_milestone_grant" ADD CONSTRAINT "promo_streak_milestone_grant_terms_valid" CHECK (("promo_streak_milestone_grant"."amount" is null OR "promo_streak_milestone_grant"."amount" > 0)
        AND ("promo_streak_milestone_grant"."rollover_multiplier" is null OR "promo_streak_milestone_grant"."rollover_multiplier" > 0)
        AND ("promo_streak_milestone_grant"."claim_expiry_days" is null OR "promo_streak_milestone_grant"."claim_expiry_days" > 0));
CREATE TABLE "promo_rank_round_wager" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"provider_name" text NOT NULL,
	"external_round_id" text NOT NULL,
	"currency" text NOT NULL,
	"ladder_currency" text NOT NULL,
	"stake" numeric(38, 18) NOT NULL,
	"margin" numeric(38, 18) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "promo_rank_round_wager_non_negative" CHECK ("promo_rank_round_wager"."stake" >= 0 AND "promo_rank_round_wager"."margin" >= 0)
);
--> statement-breakpoint
ALTER TABLE "promo_rank_period_wager" ADD COLUMN "margin" numeric(38, 18) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "promo_rank_tier" ADD COLUMN "daily_bonus_percent" numeric(5, 2);--> statement-breakpoint
ALTER TABLE "promo_rank_tier" ADD COLUMN "weekly_bonus_percent" numeric(5, 2);--> statement-breakpoint
ALTER TABLE "promo_rank_tier" ADD COLUMN "monthly_bonus_percent" numeric(5, 2);--> statement-breakpoint
CREATE UNIQUE INDEX "promo_rank_round_wager_round_idx" ON "promo_rank_round_wager" USING btree ("user_id","provider_name","currency","external_round_id","ladder_currency");--> statement-breakpoint
ALTER TABLE "promo_rank_period_wager" ADD CONSTRAINT "promo_rank_period_wager_margin_non_negative" CHECK ("promo_rank_period_wager"."margin" >= 0);--> statement-breakpoint
ALTER TABLE "promo_rank_tier" ADD CONSTRAINT "promo_rank_tier_bonus_percent_bounds" CHECK (("promo_rank_tier"."daily_bonus_percent" is null OR ("promo_rank_tier"."daily_bonus_percent" > 0 AND "promo_rank_tier"."daily_bonus_percent" <= 100))
        AND ("promo_rank_tier"."weekly_bonus_percent" is null OR ("promo_rank_tier"."weekly_bonus_percent" > 0 AND "promo_rank_tier"."weekly_bonus_percent" <= 100))
        AND ("promo_rank_tier"."monthly_bonus_percent" is null OR ("promo_rank_tier"."monthly_bonus_percent" > 0 AND "promo_rank_tier"."monthly_bonus_percent" <= 100)));--> statement-breakpoint
ALTER TABLE "promo_rank_tier" ADD CONSTRAINT "promo_rank_tier_total_percent" CHECK ("promo_rank_tier"."rakeback_percent" + coalesce("promo_rank_tier"."daily_bonus_percent", 0)
        + coalesce("promo_rank_tier"."weekly_bonus_percent", 0) + coalesce("promo_rank_tier"."monthly_bonus_percent", 0) <= 100);
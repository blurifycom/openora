CREATE TABLE "promo_player_streak" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"current" integer DEFAULT 0 NOT NULL,
	"best" integer DEFAULT 0 NOT NULL,
	"last_qualifying_day" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "promo_player_streak_userId_unique" UNIQUE("user_id"),
	CONSTRAINT "promo_player_streak_counts_non_negative" CHECK ("promo_player_streak"."current" >= 0 AND "promo_player_streak"."best" >= 0 AND "promo_player_streak"."current" <= "promo_player_streak"."best")
);
--> statement-breakpoint
CREATE TABLE "promo_race" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"currency" text NOT NULL,
	"start_at" timestamp with time zone NOT NULL,
	"end_at" timestamp with time zone NOT NULL,
	"prize_pool" numeric(38, 18) NOT NULL,
	"positions" jsonb NOT NULL,
	"eligible_products" text[] DEFAULT '{}' NOT NULL,
	"closed_at" timestamp with time zone,
	"created_by" uuid,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "promo_race_prize_pool_positive" CHECK ("promo_race"."prize_pool" > 0),
	CONSTRAINT "promo_race_dates_ordered" CHECK ("promo_race"."end_at" > "promo_race"."start_at")
);
--> statement-breakpoint
CREATE TABLE "promo_race_payout" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"race_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"amount" numeric(38, 18) NOT NULL,
	"currency" text NOT NULL,
	"settled_at" timestamp with time zone DEFAULT now() NOT NULL,
	"grant_id" uuid,
	"outcome" text NOT NULL,
	CONSTRAINT "promo_race_payout_position_positive" CHECK ("promo_race_payout"."position" > 0),
	CONSTRAINT "promo_race_payout_amount_non_negative" CHECK ("promo_race_payout"."amount" >= 0)
);
--> statement-breakpoint
CREATE TABLE "promo_race_wager" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"race_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"currency" text NOT NULL,
	"wagered" numeric(38, 18) DEFAULT '0' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "promo_race_wager_non_negative" CHECK ("promo_race_wager"."wagered" >= 0)
);
--> statement-breakpoint
CREATE TABLE "promo_rank_challenge_claim" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tier_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"currency" text NOT NULL,
	"cash_amount" numeric(38, 18),
	"physical_item" text,
	"claimed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"settled_at" timestamp with time zone,
	"outcome" text,
	"cash_grant_id" uuid,
	"physical_fulfilled_at" timestamp with time zone,
	"physical_fulfilled_by" uuid,
	"physical_fulfillment_note" text
);
--> statement-breakpoint
CREATE TABLE "promo_rank_challenge_tier" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"position" integer NOT NULL,
	"currency" text NOT NULL,
	"wager_threshold" numeric(38, 18) NOT NULL,
	"cash_amount" numeric(38, 18),
	"physical_item" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "promo_rank_challenge_tier_key_unique" UNIQUE("key"),
	CONSTRAINT "promo_rank_challenge_tier_position_unique" UNIQUE("position"),
	CONSTRAINT "promo_rank_challenge_tier_bounds" CHECK ("promo_rank_challenge_tier"."position" >= 0 AND "promo_rank_challenge_tier"."wager_threshold" >= 0
        AND ("promo_rank_challenge_tier"."cash_amount" is null OR "promo_rank_challenge_tier"."cash_amount" > 0)
        AND ("promo_rank_challenge_tier"."physical_item" is not null OR "promo_rank_challenge_tier"."cash_amount" is not null))
);
--> statement-breakpoint
CREATE TABLE "promo_rank_challenge_wager" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"currency" text NOT NULL,
	"lifetime_wagered" numeric(38, 18) DEFAULT '0' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "promo_rank_challenge_wager_userId_unique" UNIQUE("user_id"),
	CONSTRAINT "promo_rank_challenge_wager_non_negative" CHECK ("promo_rank_challenge_wager"."lifetime_wagered" >= 0)
);
--> statement-breakpoint
CREATE TABLE "promo_streak_config" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"singleton_key" text DEFAULT 'global' NOT NULL,
	"currency" text NOT NULL,
	"daily_min_wager" numeric(38, 18) NOT NULL,
	"eligible_products" text[] DEFAULT '{}' NOT NULL,
	"milestones" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"reset_after_day" integer DEFAULT 30 NOT NULL,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "promo_streak_config_singletonKey_unique" UNIQUE("singleton_key")
);
--> statement-breakpoint
CREATE TABLE "promo_streak_daily_wager" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"day" date NOT NULL,
	"currency" text NOT NULL,
	"wagered" numeric(38, 18) DEFAULT '0' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "promo_streak_daily_wager_non_negative" CHECK ("promo_streak_daily_wager"."wagered" >= 0)
);
--> statement-breakpoint
CREATE TABLE "promo_streak_milestone_grant" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"day" integer NOT NULL,
	"reached_at" timestamp with time zone DEFAULT now() NOT NULL,
	"settled_at" timestamp with time zone,
	"outcome" text,
	CONSTRAINT "promo_streak_milestone_grant_day_positive" CHECK ("promo_streak_milestone_grant"."day" > 0)
);
--> statement-breakpoint
ALTER TABLE "promo_player_rank" ADD COLUMN "rakeback_boost_percent" numeric(5, 2);--> statement-breakpoint
ALTER TABLE "promo_player_rank" ADD COLUMN "rakeback_boost_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "promo_race_payout" ADD CONSTRAINT "promo_race_payout_race_id_promo_race_id_fk" FOREIGN KEY ("race_id") REFERENCES "public"."promo_race"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "promo_race_wager" ADD CONSTRAINT "promo_race_wager_race_id_promo_race_id_fk" FOREIGN KEY ("race_id") REFERENCES "public"."promo_race"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "promo_race_open_idx" ON "promo_race" USING btree ("start_at","end_at") WHERE "promo_race"."closed_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "promo_race_payout_race_id_user_id_idx" ON "promo_race_payout" USING btree ("race_id","user_id");--> statement-breakpoint
CREATE INDEX "promo_race_payout_race_id_idx" ON "promo_race_payout" USING btree ("race_id");--> statement-breakpoint
CREATE UNIQUE INDEX "promo_race_wager_race_id_user_id_idx" ON "promo_race_wager" USING btree ("race_id","user_id");--> statement-breakpoint
CREATE INDEX "promo_race_wager_race_id_wagered_idx" ON "promo_race_wager" USING btree ("race_id","wagered");--> statement-breakpoint
CREATE UNIQUE INDEX "promo_rank_challenge_claim_tier_id_idx" ON "promo_rank_challenge_claim" USING btree ("tier_id");--> statement-breakpoint
CREATE INDEX "promo_rank_challenge_claim_unsettled_idx" ON "promo_rank_challenge_claim" USING btree ("claimed_at") WHERE "promo_rank_challenge_claim"."settled_at" is null;--> statement-breakpoint
CREATE INDEX "promo_rank_challenge_claim_fulfilment_queue_idx" ON "promo_rank_challenge_claim" USING btree ("claimed_at") WHERE "promo_rank_challenge_claim"."physical_item" is not null AND "promo_rank_challenge_claim"."physical_fulfilled_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "promo_streak_daily_wager_user_id_day_idx" ON "promo_streak_daily_wager" USING btree ("user_id","day");--> statement-breakpoint
CREATE UNIQUE INDEX "promo_streak_milestone_grant_user_id_day_idx" ON "promo_streak_milestone_grant" USING btree ("user_id","day");--> statement-breakpoint
CREATE INDEX "promo_streak_milestone_grant_unsettled_idx" ON "promo_streak_milestone_grant" USING btree ("reached_at") WHERE "promo_streak_milestone_grant"."settled_at" is null;
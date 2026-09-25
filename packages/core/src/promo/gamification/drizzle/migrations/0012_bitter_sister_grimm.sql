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
CREATE UNIQUE INDEX "promo_streak_daily_wager_user_id_day_idx" ON "promo_streak_daily_wager" USING btree ("user_id","day");--> statement-breakpoint
CREATE UNIQUE INDEX "promo_streak_milestone_grant_user_id_day_idx" ON "promo_streak_milestone_grant" USING btree ("user_id","day");--> statement-breakpoint
CREATE INDEX "promo_streak_milestone_grant_unsettled_idx" ON "promo_streak_milestone_grant" USING btree ("reached_at") WHERE "promo_streak_milestone_grant"."settled_at" is null;
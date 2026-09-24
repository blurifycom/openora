CREATE TABLE "promo_player_rank" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"currency" text NOT NULL,
	"lifetime_wagered" numeric(38, 18) DEFAULT '0' NOT NULL,
	"tier_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "promo_player_rank_userId_unique" UNIQUE("user_id"),
	CONSTRAINT "promo_player_rank_lifetime_wagered_non_negative" CHECK ("promo_player_rank"."lifetime_wagered" >= 0)
);
--> statement-breakpoint
CREATE TABLE "promo_rank_tier" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"position" integer NOT NULL,
	"currency" text NOT NULL,
	"wager_threshold" numeric(38, 18) NOT NULL,
	"rakeback_percent" numeric(5, 2) NOT NULL,
	"daily_bonus" numeric(38, 18),
	"weekly_bonus" numeric(38, 18),
	"monthly_bonus" numeric(38, 18),
	"level_up_bonus" numeric(38, 18),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "promo_rank_tier_key_unique" UNIQUE("key"),
	CONSTRAINT "promo_rank_tier_position_unique" UNIQUE("position"),
	CONSTRAINT "promo_rank_tier_bounds" CHECK ("promo_rank_tier"."position" >= 0 AND "promo_rank_tier"."wager_threshold" >= 0
        AND "promo_rank_tier"."rakeback_percent" >= 0 AND "promo_rank_tier"."rakeback_percent" <= 100
        AND ("promo_rank_tier"."daily_bonus" is null OR "promo_rank_tier"."daily_bonus" > 0)
        AND ("promo_rank_tier"."weekly_bonus" is null OR "promo_rank_tier"."weekly_bonus" > 0)
        AND ("promo_rank_tier"."monthly_bonus" is null OR "promo_rank_tier"."monthly_bonus" > 0)
        AND ("promo_rank_tier"."level_up_bonus" is null OR "promo_rank_tier"."level_up_bonus" > 0))
);
--> statement-breakpoint
ALTER TABLE "promo_player_rank" ADD CONSTRAINT "promo_player_rank_tier_id_promo_rank_tier_id_fk" FOREIGN KEY ("tier_id") REFERENCES "public"."promo_rank_tier"("id") ON DELETE no action ON UPDATE no action;
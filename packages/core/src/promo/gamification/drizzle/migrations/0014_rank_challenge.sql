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
CREATE UNIQUE INDEX "promo_rank_challenge_claim_tier_id_idx" ON "promo_rank_challenge_claim" USING btree ("tier_id");--> statement-breakpoint
CREATE INDEX "promo_rank_challenge_claim_unsettled_idx" ON "promo_rank_challenge_claim" USING btree ("claimed_at") WHERE "promo_rank_challenge_claim"."settled_at" is null;--> statement-breakpoint
CREATE INDEX "promo_rank_challenge_claim_fulfilment_queue_idx" ON "promo_rank_challenge_claim" USING btree ("claimed_at") WHERE "promo_rank_challenge_claim"."physical_item" is not null AND "promo_rank_challenge_claim"."physical_fulfilled_at" is null;
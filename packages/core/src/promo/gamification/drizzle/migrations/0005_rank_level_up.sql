CREATE TABLE "promo_rank_level_up" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"tier_id" uuid NOT NULL,
	"currency" text NOT NULL,
	"amount" numeric(38, 18) NOT NULL,
	"reached_at" timestamp with time zone DEFAULT now() NOT NULL,
	"settled_at" timestamp with time zone,
	"outcome" text,
	"grant_id" uuid,
	CONSTRAINT "promo_rank_level_up_amount_positive" CHECK ("promo_rank_level_up"."amount" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "promo_rank_level_up_user_id_tier_id_idx" ON "promo_rank_level_up" USING btree ("user_id","tier_id");--> statement-breakpoint
CREATE INDEX "promo_rank_level_up_unsettled_idx" ON "promo_rank_level_up" USING btree ("reached_at") WHERE "promo_rank_level_up"."settled_at" is null;
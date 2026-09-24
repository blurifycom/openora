CREATE TABLE "promo_rank_period_wager" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"period_key" text NOT NULL,
	"currency" text NOT NULL,
	"wagered" numeric(38, 18) DEFAULT '0' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "promo_rank_period_wager_non_negative" CHECK ("promo_rank_period_wager"."wagered" >= 0)
);
--> statement-breakpoint
ALTER TABLE "promo_rank_config" ADD COLUMN "periodic_minimum_wager" numeric(38, 18);--> statement-breakpoint
CREATE UNIQUE INDEX "promo_rank_period_wager_user_id_kind_period_key_idx" ON "promo_rank_period_wager" USING btree ("user_id","kind","period_key");--> statement-breakpoint
CREATE INDEX "promo_rank_period_wager_kind_period_key_idx" ON "promo_rank_period_wager" USING btree ("kind","period_key");
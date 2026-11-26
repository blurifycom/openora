CREATE TYPE "public"."promo_rank_periodic_reward_kind" AS ENUM('daily', 'weekly', 'monthly');--> statement-breakpoint
CREATE TYPE "public"."promo_rank_periodic_reward_status" AS ENUM('claimable', 'claimed', 'auto_paid');--> statement-breakpoint
CREATE TABLE "promo_rank_period_payout" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" "promo_rank_periodic_reward_kind" NOT NULL,
	"period_key" text NOT NULL,
	"terms" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "promo_rank_periodic_reward" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" "promo_rank_periodic_reward_kind" NOT NULL,
	"period_key" text NOT NULL,
	"period_start" timestamp with time zone NOT NULL,
	"period_end" timestamp with time zone NOT NULL,
	"tier_id" uuid NOT NULL,
	"ladder_currency" text NOT NULL,
	"ladder_amount" numeric(38, 18) NOT NULL,
	"currency" text NOT NULL,
	"amount" numeric(38, 18) NOT NULL,
	"status" "promo_rank_periodic_reward_status" DEFAULT 'claimable' NOT NULL,
	"idempotency_key" text,
	"transaction_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"settled_at" timestamp with time zone,
	CONSTRAINT "promo_rank_periodic_reward_amounts_positive" CHECK ("promo_rank_periodic_reward"."amount" > 0 AND "promo_rank_periodic_reward"."ladder_amount" > 0),
	CONSTRAINT "promo_rank_periodic_reward_settlement" CHECK (("promo_rank_periodic_reward"."status" = 'claimable') = ("promo_rank_periodic_reward"."settled_at" is null) AND ("promo_rank_periodic_reward"."status" = 'claimable') = ("promo_rank_periodic_reward"."transaction_id" is null))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "promo_rank_period_payout_kind_period_key_idx" ON "promo_rank_period_payout" USING btree ("kind","period_key");--> statement-breakpoint
CREATE UNIQUE INDEX "promo_rank_periodic_reward_user_id_kind_period_key_idx" ON "promo_rank_periodic_reward" USING btree ("user_id","kind","period_key");--> statement-breakpoint
CREATE UNIQUE INDEX "promo_rank_periodic_reward_user_id_idempotency_key_idx" ON "promo_rank_periodic_reward" USING btree ("user_id","idempotency_key") WHERE "promo_rank_periodic_reward"."idempotency_key" is not null;--> statement-breakpoint
CREATE INDEX "promo_rank_periodic_reward_user_id_status_idx" ON "promo_rank_periodic_reward" USING btree ("user_id","status");--> statement-breakpoint
CREATE INDEX "promo_rank_periodic_reward_claimable_idx" ON "promo_rank_periodic_reward" USING btree ("currency","user_id") WHERE "promo_rank_periodic_reward"."status" = 'claimable';--> statement-breakpoint
CREATE INDEX "promo_rank_periodic_reward_created_at_idx" ON "promo_rank_periodic_reward" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "promo_rank_periodic_reward_settled_at_idx" ON "promo_rank_periodic_reward" USING btree ("settled_at") WHERE "promo_rank_periodic_reward"."status" <> 'claimable';
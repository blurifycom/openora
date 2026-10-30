CREATE TYPE "public"."promo_rakeback_accrual_status" AS ENUM('accrued', 'claimed', 'reversed', 'voided');--> statement-breakpoint
CREATE TYPE "public"."promo_rakeback_basis" AS ENUM('stake', 'margin');--> statement-breakpoint
CREATE TYPE "public"."promo_rakeback_claim_outcome" AS ENUM('claimed', 'auto_paid');--> statement-breakpoint
CREATE TABLE "promo_rakeback_accrual" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"currency" text NOT NULL,
	"amount" numeric(38, 18) NOT NULL,
	"stake" numeric(38, 18) NOT NULL,
	"rolled_back_stake" numeric(38, 18) DEFAULT '0' NOT NULL,
	"basis" "promo_rakeback_basis" NOT NULL,
	"rtp" numeric(19, 18),
	"rate_percent" numeric(5, 2) NOT NULL,
	"boost_percent" numeric(5, 2) NOT NULL,
	"game_id" text,
	"provider_game_key" text,
	"provider_name" text,
	"external_round_id" text,
	"status" "promo_rakeback_accrual_status" DEFAULT 'accrued' NOT NULL,
	"claim_id" uuid,
	"voided_by" uuid,
	"void_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"settled_at" timestamp with time zone,
	CONSTRAINT "promo_rakeback_accrual_bounds" CHECK ("promo_rakeback_accrual"."amount" > 0 AND "promo_rakeback_accrual"."stake" >= 0 AND "promo_rakeback_accrual"."rolled_back_stake" >= 0 AND "promo_rakeback_accrual"."rolled_back_stake" <= "promo_rakeback_accrual"."stake" AND ("promo_rakeback_accrual"."rtp" is null OR ("promo_rakeback_accrual"."rtp" > 0 AND "promo_rakeback_accrual"."rtp" <= 1))),
	CONSTRAINT "promo_rakeback_accrual_settlement" CHECK (("promo_rakeback_accrual"."status" = 'claimed') = ("promo_rakeback_accrual"."claim_id" is not null)
        AND ("promo_rakeback_accrual"."status" = 'voided') = ("promo_rakeback_accrual"."void_reason" is not null))
);
--> statement-breakpoint
CREATE TABLE "promo_rakeback_claim" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"idempotency_key" text NOT NULL,
	"outcome" "promo_rakeback_claim_outcome" NOT NULL,
	"settled_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "promo_rakeback_claim_payout" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"claim_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"currency" text NOT NULL,
	"amount" numeric(38, 18) NOT NULL,
	"transaction_id" uuid NOT NULL,
	CONSTRAINT "promo_rakeback_claim_payout_amount_positive" CHECK ("promo_rakeback_claim_payout"."amount" > 0)
);
--> statement-breakpoint
ALTER TABLE "promo_player_rank" ADD COLUMN "last_claimable_notified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "promo_player_rank" ADD COLUMN "rakeback_reminder_checked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "promo_rakeback_accrual" ADD CONSTRAINT "promo_rakeback_accrual_claim_id_promo_rakeback_claim_id_fk" FOREIGN KEY ("claim_id") REFERENCES "public"."promo_rakeback_claim"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "promo_rakeback_claim_payout" ADD CONSTRAINT "promo_rakeback_claim_payout_claim_id_promo_rakeback_claim_id_fk" FOREIGN KEY ("claim_id") REFERENCES "public"."promo_rakeback_claim"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "promo_rakeback_accrual_user_id_status_idx" ON "promo_rakeback_accrual" USING btree ("user_id","status");--> statement-breakpoint
CREATE INDEX "promo_rakeback_accrual_round_idx" ON "promo_rakeback_accrual" USING btree ("user_id","provider_name","currency","external_round_id");--> statement-breakpoint
CREATE INDEX "promo_rakeback_accrual_claim_id_idx" ON "promo_rakeback_accrual" USING btree ("claim_id");--> statement-breakpoint
CREATE INDEX "promo_rakeback_accrual_unclaimed_idx" ON "promo_rakeback_accrual" USING btree ("currency","user_id") WHERE "promo_rakeback_accrual"."status" = 'accrued';--> statement-breakpoint
CREATE INDEX "promo_rakeback_accrual_created_at_idx" ON "promo_rakeback_accrual" USING btree ("created_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "promo_rakeback_claim_user_id_idempotency_key_idx" ON "promo_rakeback_claim" USING btree ("user_id","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "promo_rakeback_claim_payout_claim_id_currency_idx" ON "promo_rakeback_claim_payout" USING btree ("claim_id","currency");--> statement-breakpoint
CREATE INDEX "promo_rakeback_claim_payout_user_id_currency_idx" ON "promo_rakeback_claim_payout" USING btree ("user_id","currency");
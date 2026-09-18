CREATE TYPE "public"."promo_offer_status" AS ENUM('draft', 'active', 'paused', 'archived');--> statement-breakpoint
CREATE TABLE "promo_offer" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"status" "promo_offer_status" DEFAULT 'draft' NOT NULL,
	"currency" text NOT NULL,
	"match_percent" numeric(5, 2) NOT NULL,
	"max_grant_amount" numeric(38, 18) NOT NULL,
	"min_deposit" numeric(38, 18) NOT NULL,
	"terms" jsonb NOT NULL,
	"rules" jsonb NOT NULL,
	"requires_opt_in" boolean DEFAULT false NOT NULL,
	"valid_from" timestamp with time zone,
	"valid_until" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "promo_offer_key_unique" UNIQUE("key"),
	CONSTRAINT "promo_offer_match_percent_positive" CHECK ("promo_offer"."match_percent" > 0 AND "promo_offer"."max_grant_amount" > 0 AND "promo_offer"."min_deposit" >= 0)
);
--> statement-breakpoint
CREATE TABLE "promo_opt_in" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"offer_id" uuid NOT NULL,
	"accumulated_deposit" numeric(38, 18) DEFAULT '0' NOT NULL,
	"grant_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "promo_opt_in" ADD CONSTRAINT "promo_opt_in_offer_id_promo_offer_id_fk" FOREIGN KEY ("offer_id") REFERENCES "public"."promo_offer"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "promo_offer_status_valid_from_valid_until_idx" ON "promo_offer" USING btree ("status","valid_from","valid_until");--> statement-breakpoint
CREATE UNIQUE INDEX "promo_opt_in_user_id_offer_id_idx" ON "promo_opt_in" USING btree ("user_id","offer_id");
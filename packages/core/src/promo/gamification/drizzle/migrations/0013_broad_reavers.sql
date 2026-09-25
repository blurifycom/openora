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
ALTER TABLE "promo_race_payout" ADD CONSTRAINT "promo_race_payout_race_id_promo_race_id_fk" FOREIGN KEY ("race_id") REFERENCES "public"."promo_race"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "promo_race_wager" ADD CONSTRAINT "promo_race_wager_race_id_promo_race_id_fk" FOREIGN KEY ("race_id") REFERENCES "public"."promo_race"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "promo_race_open_idx" ON "promo_race" USING btree ("start_at","end_at") WHERE "promo_race"."closed_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "promo_race_payout_race_id_user_id_idx" ON "promo_race_payout" USING btree ("race_id","user_id");--> statement-breakpoint
CREATE INDEX "promo_race_payout_race_id_idx" ON "promo_race_payout" USING btree ("race_id");--> statement-breakpoint
CREATE UNIQUE INDEX "promo_race_wager_race_id_user_id_idx" ON "promo_race_wager" USING btree ("race_id","user_id");--> statement-breakpoint
CREATE INDEX "promo_race_wager_race_id_wagered_idx" ON "promo_race_wager" USING btree ("race_id","wagered");
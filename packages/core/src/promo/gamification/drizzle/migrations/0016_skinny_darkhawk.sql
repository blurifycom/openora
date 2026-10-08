CREATE TABLE "promo_race_round_wager" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"race_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"provider_name" text NOT NULL,
	"currency" text NOT NULL,
	"external_round_id" text NOT NULL,
	"stake" numeric(38, 18) NOT NULL,
	"wagered" numeric(38, 18) NOT NULL,
	CONSTRAINT "promo_race_round_wager_non_negative" CHECK ("promo_race_round_wager"."stake" >= 0 AND "promo_race_round_wager"."wagered" >= 0)
);
--> statement-breakpoint
CREATE TABLE "promo_streak_round_wager" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"provider_name" text NOT NULL,
	"currency" text NOT NULL,
	"external_round_id" text NOT NULL,
	"day" date NOT NULL,
	"stake" numeric(38, 18) NOT NULL,
	"wagered" numeric(38, 18) NOT NULL,
	CONSTRAINT "promo_streak_round_wager_non_negative" CHECK ("promo_streak_round_wager"."stake" >= 0 AND "promo_streak_round_wager"."wagered" >= 0)
);
--> statement-breakpoint
ALTER TABLE "promo_race_round_wager" ADD CONSTRAINT "promo_race_round_wager_race_id_promo_race_id_fk" FOREIGN KEY ("race_id") REFERENCES "public"."promo_race"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "promo_race_round_wager_round_idx" ON "promo_race_round_wager" USING btree ("race_id","user_id","provider_name","currency","external_round_id");--> statement-breakpoint
CREATE INDEX "promo_race_round_wager_user_id_external_round_id_idx" ON "promo_race_round_wager" USING btree ("user_id","external_round_id");--> statement-breakpoint
CREATE UNIQUE INDEX "promo_streak_round_wager_round_idx" ON "promo_streak_round_wager" USING btree ("user_id","provider_name","currency","external_round_id","day");--> statement-breakpoint
CREATE INDEX "promo_streak_round_wager_day_idx" ON "promo_streak_round_wager" USING btree ("day");
CREATE TYPE "public"."promo_grant_entry_type" AS ENUM('grant', 'stake', 'win', 'reversal', 'convert', 'forfeit', 'expire');--> statement-breakpoint
CREATE TABLE "promo_grant_entry" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"grant_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"currency" text NOT NULL,
	"type" "promo_grant_entry_type" NOT NULL,
	"bonus_amount" numeric(38, 18) NOT NULL,
	"real_amount" numeric(38, 18) DEFAULT '0' NOT NULL,
	"wagering_delta" numeric(38, 18) DEFAULT '0' NOT NULL,
	"balance_after" numeric(38, 18) NOT NULL,
	"external_round_id" text,
	"wallet_transaction_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "promo_grant_entry" ADD CONSTRAINT "promo_grant_entry_grant_id_promo_grant_id_fk" FOREIGN KEY ("grant_id") REFERENCES "public"."promo_grant"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "promo_grant_entry_user_id_external_round_id_idx" ON "promo_grant_entry" USING btree ("user_id","external_round_id") WHERE "promo_grant_entry"."external_round_id" is not null;--> statement-breakpoint
CREATE INDEX "promo_grant_entry_grant_id_created_at_idx" ON "promo_grant_entry" USING btree ("grant_id","created_at");--> statement-breakpoint
CREATE INDEX "promo_grant_entry_user_id_created_at_idx" ON "promo_grant_entry" USING btree ("user_id","created_at");
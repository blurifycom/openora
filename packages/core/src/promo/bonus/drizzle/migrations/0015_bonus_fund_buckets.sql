ALTER TYPE "public"."promo_grant_status" ADD VALUE 'depleted';--> statement-breakpoint
CREATE TABLE "promo_grant_deposit" (
	"transaction_id" uuid PRIMARY KEY NOT NULL,
	"grant_id" uuid NOT NULL,
	"amount" numeric(38, 18) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "promo_grant_round" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"grant_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"currency" text NOT NULL,
	"provider_name" text NOT NULL,
	"external_round_id" text NOT NULL,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"settled_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "promo_offer" ALTER COLUMN "requires_opt_in" SET DEFAULT true;--> statement-breakpoint
ALTER TABLE "promo_grant" ADD COLUMN "unlinked_cash" numeric(38, 18) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "promo_grant" ADD COLUMN "linked_cash" numeric(38, 18) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "promo_grant_entry" ADD COLUMN "unlinked_amount" numeric(38, 18) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "promo_grant_entry" ADD COLUMN "linked_amount" numeric(38, 18) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "promo_grant_deposit" ADD CONSTRAINT "promo_grant_deposit_grant_id_promo_grant_id_fk" FOREIGN KEY ("grant_id") REFERENCES "public"."promo_grant"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "promo_grant_round" ADD CONSTRAINT "promo_grant_round_grant_id_user_id_currency_promo_grant_id_user_id_currency_fk" FOREIGN KEY ("grant_id","user_id","currency") REFERENCES "public"."promo_grant"("id","user_id","currency") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "promo_grant_round_grant_id_provider_name_external_round_id_idx" ON "promo_grant_round" USING btree ("grant_id","provider_name","external_round_id");--> statement-breakpoint
CREATE INDEX "promo_grant_round_grant_id_open_idx" ON "promo_grant_round" USING btree ("grant_id") WHERE "promo_grant_round"."settled_at" is null;--> statement-breakpoint
ALTER TABLE "promo_grant" ADD CONSTRAINT "promo_grant_cash_buckets_non_negative" CHECK ("promo_grant"."unlinked_cash" >= 0 AND "promo_grant"."linked_cash" >= 0);
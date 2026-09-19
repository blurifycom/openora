CREATE TABLE "promo_opt_in_deposit" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"opt_in_id" uuid NOT NULL,
	"transaction_id" uuid NOT NULL,
	"amount" numeric(38, 18) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "promo_opt_in_deposit" ADD CONSTRAINT "promo_opt_in_deposit_opt_in_id_promo_opt_in_id_fk" FOREIGN KEY ("opt_in_id") REFERENCES "public"."promo_opt_in"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "promo_opt_in_deposit_opt_in_id_transaction_id_idx" ON "promo_opt_in_deposit" USING btree ("opt_in_id","transaction_id");
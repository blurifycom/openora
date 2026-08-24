CREATE TABLE "wallet_withdrawal_address" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"label" text NOT NULL,
	"currency" text NOT NULL,
	"network" text NOT NULL,
	"address" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "wallet_withdrawal_address_user_id_currency_network_address_idx" ON "wallet_withdrawal_address" USING btree ("user_id","currency","network","address");--> statement-breakpoint
CREATE INDEX "wallet_withdrawal_address_user_id_created_at_idx" ON "wallet_withdrawal_address" USING btree ("user_id","created_at");
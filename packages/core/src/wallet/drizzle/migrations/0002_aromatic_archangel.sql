CREATE TABLE "wallet_deposit_address" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"currency" text NOT NULL,
	"address" text NOT NULL,
	"provider_name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DROP INDEX "wallet_transaction_provider_ref_id_idx";--> statement-breakpoint
ALTER TABLE "auto_withdrawal_rule" ALTER COLUMN "threshold" SET DATA TYPE numeric(18, 8);--> statement-breakpoint
ALTER TABLE "wallet" ALTER COLUMN "balance" SET DATA TYPE numeric(18, 8);--> statement-breakpoint
ALTER TABLE "wallet" ALTER COLUMN "balance" SET DEFAULT '0';--> statement-breakpoint
ALTER TABLE "wallet_transaction" ALTER COLUMN "amount" SET DATA TYPE numeric(18, 8);--> statement-breakpoint
ALTER TABLE "wallet_transaction" ADD COLUMN "destination_address" text;--> statement-breakpoint
ALTER TABLE "wallet_transaction" ADD COLUMN "tx_hash" text;--> statement-breakpoint
CREATE UNIQUE INDEX "wallet_deposit_address_user_id_currency_idx" ON "wallet_deposit_address" USING btree ("user_id","currency");--> statement-breakpoint
CREATE INDEX "wallet_deposit_address_address_idx" ON "wallet_deposit_address" USING btree ("address");--> statement-breakpoint
CREATE INDEX "wallet_transaction_tx_hash_idx" ON "wallet_transaction" USING btree ("tx_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "wallet_transaction_provider_ref_id_idx" ON "wallet_transaction" USING btree ("provider_ref_id") WHERE "wallet_transaction"."provider_ref_id" IS NOT NULL;

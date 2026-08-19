CREATE TABLE "wallet_balance" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"wallet_id" uuid NOT NULL,
	"currency" text NOT NULL,
	"amount" numeric(38, 18) DEFAULT '0' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "auto_withdrawal_rule" ALTER COLUMN "threshold" SET DATA TYPE numeric(38, 18);--> statement-breakpoint
ALTER TABLE "wallet" ALTER COLUMN "balance" SET DATA TYPE numeric(38, 18);--> statement-breakpoint
ALTER TABLE "wallet" ALTER COLUMN "balance" SET DEFAULT '0';--> statement-breakpoint
ALTER TABLE "wallet_auto_withdrawal_config" ALTER COLUMN "fiat_threshold" SET DATA TYPE numeric(38, 18);--> statement-breakpoint
ALTER TABLE "wallet_auto_withdrawal_config" ALTER COLUMN "crypto_threshold" SET DATA TYPE numeric(38, 18);--> statement-breakpoint
ALTER TABLE "wallet_transaction" ALTER COLUMN "amount" SET DATA TYPE numeric(38, 18);--> statement-breakpoint
ALTER TABLE "wallet_balance" ADD CONSTRAINT "wallet_balance_wallet_id_wallet_id_fk" FOREIGN KEY ("wallet_id") REFERENCES "public"."wallet"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "wallet_balance_wallet_id_currency_idx" ON "wallet_balance" USING btree ("wallet_id","currency");
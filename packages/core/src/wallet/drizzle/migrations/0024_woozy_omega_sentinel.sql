ALTER TABLE "wallet_transaction" ADD COLUMN "reference_currency" text;--> statement-breakpoint
ALTER TABLE "wallet_transaction" ADD COLUMN "reference_amount" numeric(38, 18);--> statement-breakpoint
ALTER TABLE "wallet_transaction" ADD COLUMN "reference_rate" numeric(38, 18);--> statement-breakpoint
ALTER TABLE "wallet_transaction" ADD COLUMN "reference_rate_as_of" timestamp with time zone;
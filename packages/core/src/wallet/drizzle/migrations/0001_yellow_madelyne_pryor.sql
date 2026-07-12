ALTER TABLE "auto_withdrawal_rule" ADD COLUMN "threshold_cents" integer NOT NULL;--> statement-breakpoint
ALTER TABLE "wallet" ADD COLUMN "balance_cents" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "wallet_transaction" ADD COLUMN "amount_cents" integer NOT NULL;--> statement-breakpoint
ALTER TABLE "auto_withdrawal_rule" DROP COLUMN "threshold";--> statement-breakpoint
ALTER TABLE "wallet" DROP COLUMN "balance";--> statement-breakpoint
ALTER TABLE "wallet_transaction" DROP COLUMN "amount";

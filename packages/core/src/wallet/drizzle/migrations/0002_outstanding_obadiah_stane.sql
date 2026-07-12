ALTER TABLE "auto_withdrawal_rule" ADD COLUMN "threshold" numeric(18, 2) NOT NULL;--> statement-breakpoint
ALTER TABLE "wallet" ADD COLUMN "balance" numeric(18, 2) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "wallet_transaction" ADD COLUMN "amount" numeric(18, 2) NOT NULL;--> statement-breakpoint
ALTER TABLE "auto_withdrawal_rule" DROP COLUMN "threshold_cents";--> statement-breakpoint
ALTER TABLE "wallet" DROP COLUMN "balance_cents";--> statement-breakpoint
ALTER TABLE "wallet_transaction" DROP COLUMN "amount_cents";

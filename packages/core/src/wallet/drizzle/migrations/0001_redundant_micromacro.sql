ALTER TABLE "auto_withdrawal_rule" ALTER COLUMN "threshold" SET DATA TYPE numeric(18, 2);--> statement-breakpoint
ALTER TABLE "wallet" ALTER COLUMN "balance" SET DATA TYPE numeric(18, 2);--> statement-breakpoint
ALTER TABLE "wallet" ALTER COLUMN "balance" SET DEFAULT '0';--> statement-breakpoint
ALTER TABLE "wallet_transaction" ALTER COLUMN "amount" SET DATA TYPE numeric(18, 2);

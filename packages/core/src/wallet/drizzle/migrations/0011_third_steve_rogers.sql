ALTER TABLE "wallet_transaction" ADD COLUMN "network" text;--> statement-breakpoint
CREATE INDEX "wallet_transaction_currency_network_idx" ON "wallet_transaction" USING btree ("currency","network");
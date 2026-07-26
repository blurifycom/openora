CREATE INDEX "wallet_transaction_status_type_created_at_idx" ON "wallet_transaction" USING btree ("status","type","created_at");--> statement-breakpoint
CREATE INDEX "wallet_transaction_wallet_id_type_status_idx" ON "wallet_transaction" USING btree ("wallet_id","type","status");

ALTER TABLE "wallet_transaction" ADD COLUMN "idempotency_key" uuid;--> statement-breakpoint
CREATE UNIQUE INDEX "wallet_transaction_wallet_id_idempotency_key_idx" ON "wallet_transaction" USING btree ("wallet_id","idempotency_key") WHERE "wallet_transaction"."idempotency_key" IS NOT NULL;

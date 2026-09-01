ALTER TYPE "public"."wallet_transaction_type" ADD VALUE 'bet_reversal';--> statement-breakpoint
ALTER TABLE "wallet_transaction" ADD COLUMN "external_round_id" text;--> statement-breakpoint
CREATE INDEX "wallet_transaction_external_round_id_idx" ON "wallet_transaction" USING btree ("external_round_id");
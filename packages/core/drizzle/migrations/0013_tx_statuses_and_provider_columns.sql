ALTER TYPE "public"."wallet_transaction_status" ADD VALUE 'on_hold';--> statement-breakpoint
ALTER TYPE "public"."wallet_transaction_status" ADD VALUE 'cancelled';--> statement-breakpoint
ALTER TABLE "wallet_transaction" ADD COLUMN "provider_name" text;--> statement-breakpoint
ALTER TABLE "wallet_transaction" ADD COLUMN "provider_ref_id" text;--> statement-breakpoint
CREATE INDEX "wallet_transaction_provider_ref_id_idx" ON "wallet_transaction" USING btree ("provider_ref_id");

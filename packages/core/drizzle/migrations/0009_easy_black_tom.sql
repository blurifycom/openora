ALTER TYPE "public"."wallet_transaction_type" ADD VALUE 'loss';--> statement-breakpoint
ALTER TYPE "public"."wallet_transaction_type" ADD VALUE 'bonus';--> statement-breakpoint
ALTER TYPE "public"."wallet_transaction_type" ADD VALUE 'tip';--> statement-breakpoint
CREATE INDEX "wallet_transaction_created_at_idx" ON "wallet_transaction" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "wallet_transaction_type_idx" ON "wallet_transaction" USING btree ("type");--> statement-breakpoint
CREATE INDEX "wallet_transaction_status_idx" ON "wallet_transaction" USING btree ("status");--> statement-breakpoint
CREATE INDEX "wallet_transaction_rail_idx" ON "wallet_transaction" USING btree ("rail");

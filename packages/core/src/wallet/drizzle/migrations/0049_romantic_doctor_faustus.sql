ALTER TYPE "public"."wallet_reconciliation_finding_kind" ADD VALUE 'ledger_request_mismatch';--> statement-breakpoint
ALTER TYPE "public"."wallet_reconciliation_finding_kind" ADD VALUE 'ledger_unrequested_transaction';--> statement-breakpoint
ALTER TYPE "public"."wallet_reconciliation_finding_kind" ADD VALUE 'play_eligibility_drift';--> statement-breakpoint
ALTER TYPE "public"."wallet_reconciliation_finding_kind" ADD VALUE 'rg_limits_drift';--> statement-breakpoint
ALTER TYPE "public"."wallet_reconciliation_finding_kind" ADD VALUE 'outbox_relay_lag';--> statement-breakpoint
ALTER TYPE "public"."wallet_reconciliation_finding_kind" ADD VALUE 'event_dead_letters';--> statement-breakpoint
ALTER TABLE "ledger_api_request" ADD COLUMN "user_id" uuid;--> statement-breakpoint
ALTER TABLE "ledger_api_request" ADD COLUMN "amount" numeric(38, 18);--> statement-breakpoint
CREATE INDEX "ledger_api_request_created_at_idx" ON "ledger_api_request" USING btree ("created_at");
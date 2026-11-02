ALTER TYPE "public"."wallet_transaction_type" ADD VALUE 'win_reversal';--> statement-breakpoint
CREATE TABLE "wallet_withdrawal_hold" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"source" text NOT NULL,
	"reason" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "wallet_transaction" ADD COLUMN "correction_requested_amount" numeric(38, 18);--> statement-breakpoint
CREATE UNIQUE INDEX "wallet_withdrawal_hold_user_id_source_idx" ON "wallet_withdrawal_hold" USING btree ("user_id","source");--> statement-breakpoint
CREATE INDEX "wallet_transaction_wallet_id_external_round_id_idx" ON "wallet_transaction" USING btree ("wallet_id","external_round_id") WHERE "wallet_transaction"."external_round_id" IS NOT NULL;
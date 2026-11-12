ALTER TYPE "public"."wallet_reconciliation_finding_kind" ADD VALUE 'ledger_invariant_breach';--> statement-breakpoint
CREATE TABLE "wallet_balance_baseline" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"wallet_id" uuid NOT NULL,
	"currency" text NOT NULL,
	"amount" numeric(38, 18) NOT NULL,
	"as_of" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "wallet_balance_baseline" ADD CONSTRAINT "wallet_balance_baseline_wallet_id_wallet_id_fk" FOREIGN KEY ("wallet_id") REFERENCES "public"."wallet"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "wallet_balance_baseline_wallet_id_currency_idx" ON "wallet_balance_baseline" USING btree ("wallet_id","currency");
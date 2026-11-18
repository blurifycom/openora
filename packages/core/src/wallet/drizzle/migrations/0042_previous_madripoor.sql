ALTER TYPE "public"."wallet_reconciliation_finding_kind" ADD VALUE 'ledger_invariant_breach';--> statement-breakpoint
ALTER TYPE "public"."wallet_reconciliation_finding_kind" ADD VALUE 'ledger_invariant_unchecked';--> statement-breakpoint
CREATE TABLE "wallet_balance_baseline" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"wallet_id" uuid NOT NULL,
	"currency" text NOT NULL,
	"amount" numeric(38, 18) NOT NULL,
	"as_of" timestamp with time zone NOT NULL,
	"run_id" uuid,
	"finding_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "wallet_balance_baseline" ADD CONSTRAINT "wallet_balance_baseline_wallet_id_wallet_id_fk" FOREIGN KEY ("wallet_id") REFERENCES "public"."wallet"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet_balance_baseline" ADD CONSTRAINT "wallet_balance_baseline_finding_id_wallet_reconciliation_finding_id_fk" FOREIGN KEY ("finding_id") REFERENCES "public"."wallet_reconciliation_finding"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "wallet_balance_baseline_wallet_id_currency_as_of_idx" ON "wallet_balance_baseline" USING btree ("wallet_id","currency","as_of");
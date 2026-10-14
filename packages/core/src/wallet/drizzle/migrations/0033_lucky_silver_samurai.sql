CREATE TABLE "wallet_refunded_deposit" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider_name" text NOT NULL,
	"external_id" text NOT NULL,
	"finding_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "wallet_refunded_deposit" ADD CONSTRAINT "wallet_refunded_deposit_finding_id_wallet_reconciliation_finding_id_fk" FOREIGN KEY ("finding_id") REFERENCES "public"."wallet_reconciliation_finding"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "wallet_refunded_deposit_provider_external_id_idx" ON "wallet_refunded_deposit" USING btree ("provider_name","external_id");
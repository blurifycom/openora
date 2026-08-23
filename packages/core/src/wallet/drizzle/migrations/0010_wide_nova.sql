CREATE TYPE "public"."wallet_bonus_credit_source_type" AS ENUM('gift', 'rain');--> statement-breakpoint
CREATE TYPE "public"."wallet_bonus_credit_status" AS ENUM('active', 'completed');--> statement-breakpoint
CREATE TYPE "public"."wallet_custody_sweep_status" AS ENUM('pending', 'processing', 'completed', 'failed', 'unknown');--> statement-breakpoint
CREATE TYPE "public"."wallet_job_run_status" AS ENUM('running', 'completed', 'failed', 'abandoned');--> statement-breakpoint
CREATE TYPE "public"."wallet_reconciliation_finding_kind" AS ENUM('missing_deposit', 'unattributed_deposit', 'amount_mismatch', 'currency_mismatch', 'status_mismatch', 'unknown_at_provider', 'unconfigured_asset', 'stuck_sweep');--> statement-breakpoint
CREATE TYPE "public"."wallet_reconciliation_finding_status" AS ENUM('open', 'resolved');--> statement-breakpoint
ALTER TYPE "public"."wallet_transaction_type" ADD VALUE 'manual_credit';--> statement-breakpoint
ALTER TYPE "public"."wallet_transaction_type" ADD VALUE 'manual_debit';--> statement-breakpoint
CREATE TABLE "wallet_asset" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"currency" text NOT NULL,
	"network" text NOT NULL,
	"provider_asset_id" text NOT NULL,
	"min_deposit" numeric(38, 18) NOT NULL,
	"min_withdrawal" numeric(38, 18) NOT NULL,
	"withdrawal_fee" numeric(38, 18) NOT NULL,
	"deposit_enabled" boolean DEFAULT true NOT NULL,
	"withdrawal_enabled" boolean DEFAULT true NOT NULL,
	"provider_name" text,
	"sweep_fee_ceiling" numeric(38, 18),
	"pool_liquidity_floor" numeric(38, 18),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "wallet_bonus_credit" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"wallet_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"currency" text NOT NULL,
	"source_type" "wallet_bonus_credit_source_type" NOT NULL,
	"credited_amount" numeric(38, 18) NOT NULL,
	"rollover_multiplier" numeric(38, 18) NOT NULL,
	"rollover_required" numeric(38, 18) NOT NULL,
	"rollover_progress" numeric(38, 18) DEFAULT '0' NOT NULL,
	"status" "wallet_bonus_credit_status" DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "wallet_bonus_rollover_config" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"singleton_key" text DEFAULT 'global' NOT NULL,
	"multiplier" numeric(38, 18) NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "wallet_bonus_rollover_config_singletonKey_unique" UNIQUE("singleton_key")
);
--> statement-breakpoint
CREATE TABLE "wallet_custody_sweep" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"provider_name" text NOT NULL,
	"currency" text NOT NULL,
	"network" text NOT NULL,
	"amount" numeric(38, 18) NOT NULL,
	"estimated_fee" numeric(38, 18) NOT NULL,
	"external_id" text,
	"pool_ref" text,
	"tx_hash" text,
	"status" "wallet_custody_sweep_status" DEFAULT 'pending' NOT NULL,
	"run_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "wallet_job_run" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_name" text NOT NULL,
	"run_id" uuid NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"status" "wallet_job_run_status" DEFAULT 'running' NOT NULL,
	"summary" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "wallet_reconciliation_finding" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"provider_name" text NOT NULL,
	"kind" "wallet_reconciliation_finding_kind" NOT NULL,
	"currency" text,
	"network" text,
	"amount" numeric(38, 18),
	"address" text,
	"tag" text,
	"tx_hash" text,
	"external_id" text,
	"transaction_id" uuid,
	"detail" text,
	"status" "wallet_reconciliation_finding_status" DEFAULT 'open' NOT NULL,
	"resolved_by" uuid,
	"resolved_at" timestamp with time zone,
	"resolution_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "wallet_transaction" ADD COLUMN "network" text;--> statement-breakpoint
ALTER TABLE "wallet_bonus_credit" ADD CONSTRAINT "wallet_bonus_credit_wallet_id_wallet_id_fk" FOREIGN KEY ("wallet_id") REFERENCES "public"."wallet"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "wallet_asset_currency_network_idx" ON "wallet_asset" USING btree ("currency","network");--> statement-breakpoint
CREATE INDEX "wallet_bonus_credit_user_id_currency_status_idx" ON "wallet_bonus_credit" USING btree ("user_id","currency","status");--> statement-breakpoint
CREATE INDEX "wallet_bonus_credit_wallet_id_idx" ON "wallet_bonus_credit" USING btree ("wallet_id");--> statement-breakpoint
CREATE UNIQUE INDEX "wallet_custody_sweep_user_id_currency_network_idx" ON "wallet_custody_sweep" USING btree ("user_id","currency","network") WHERE status IN ('pending','processing','unknown');--> statement-breakpoint
CREATE UNIQUE INDEX "wallet_custody_sweep_external_id_idx" ON "wallet_custody_sweep" USING btree ("external_id") WHERE "wallet_custody_sweep"."external_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "wallet_custody_sweep_status_created_at_idx" ON "wallet_custody_sweep" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "wallet_custody_sweep_provider_name_created_at_idx" ON "wallet_custody_sweep" USING btree ("provider_name","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "wallet_job_run_job_name_idx" ON "wallet_job_run" USING btree ("job_name") WHERE "wallet_job_run"."finished_at" IS NULL;--> statement-breakpoint
CREATE INDEX "wallet_job_run_job_name_started_at_idx" ON "wallet_job_run" USING btree ("job_name","started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "wallet_reconciliation_finding_kind_external_id_idx" ON "wallet_reconciliation_finding" USING btree ("kind","external_id") WHERE "wallet_reconciliation_finding"."external_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "wallet_reconciliation_finding_status_created_at_idx" ON "wallet_reconciliation_finding" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "wallet_reconciliation_finding_run_id_idx" ON "wallet_reconciliation_finding" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "wallet_transaction_currency_network_idx" ON "wallet_transaction" USING btree ("currency","network");
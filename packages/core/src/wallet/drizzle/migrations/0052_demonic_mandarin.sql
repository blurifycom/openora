CREATE TYPE "public"."wallet_turnover_entry_source" AS ENUM('deposit', 'swap_in', 'gift', 'rain', 'donation', 'grant_conversion');--> statement-breakpoint
CREATE TYPE "public"."wallet_turnover_entry_status" AS ENUM('counted', 'pending', 'cleared');--> statement-breakpoint
CREATE TYPE "public"."wallet_turnover_stake_state" AS ENUM('counted', 'deferred', 'reversal');--> statement-breakpoint
CREATE TABLE "wallet_turnover" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"pivot_currency" text NOT NULL,
	"required" numeric(38, 18) DEFAULT '0' NOT NULL,
	"progress" numeric(38, 18) DEFAULT '0' NOT NULL,
	"pending_count" integer DEFAULT 0 NOT NULL,
	"cleared_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "wallet_turnover_config" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"singleton_key" text DEFAULT 'global' NOT NULL,
	"product_percent" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "wallet_turnover_config_singletonKey_unique" UNIQUE("singleton_key")
);
--> statement-breakpoint
CREATE TABLE "wallet_turnover_entry" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"source" "wallet_turnover_entry_source" NOT NULL,
	"source_ref" text NOT NULL,
	"currency" text NOT NULL,
	"amount" numeric(38, 18) NOT NULL,
	"multiplier" numeric(38, 18) NOT NULL,
	"required_in_currency" numeric(38, 18) NOT NULL,
	"pivot_value" numeric(38, 18),
	"required" numeric(38, 18),
	"status" "wallet_turnover_entry_status" NOT NULL,
	"priced_at" timestamp with time zone,
	"cleared_at" timestamp with time zone,
	"cleared_by" uuid,
	"clear_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "wallet_transaction" ADD COLUMN "turnover_contribution" numeric(38, 18);--> statement-breakpoint
ALTER TABLE "wallet_transaction" ADD COLUMN "turnover_state" "wallet_turnover_stake_state";--> statement-breakpoint
CREATE UNIQUE INDEX "wallet_turnover_entry_source_ref_idx" ON "wallet_turnover_entry" USING btree ("source","source_ref");--> statement-breakpoint
CREATE INDEX "wallet_turnover_entry_user_id_created_at_idx" ON "wallet_turnover_entry" USING btree ("user_id","created_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "wallet_turnover_entry_pending_idx" ON "wallet_turnover_entry" USING btree ("user_id") WHERE "wallet_turnover_entry"."status" = 'pending';
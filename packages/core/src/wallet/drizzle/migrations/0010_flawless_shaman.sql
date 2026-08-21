CREATE TYPE "public"."wallet_bonus_credit_source_type" AS ENUM('gift', 'rain');--> statement-breakpoint
CREATE TYPE "public"."wallet_bonus_credit_status" AS ENUM('active', 'completed');--> statement-breakpoint
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
ALTER TABLE "wallet_bonus_credit" ADD CONSTRAINT "wallet_bonus_credit_wallet_id_wallet_id_fk" FOREIGN KEY ("wallet_id") REFERENCES "public"."wallet"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "wallet_bonus_credit_user_id_currency_status_idx" ON "wallet_bonus_credit" USING btree ("user_id","currency","status");--> statement-breakpoint
CREATE INDEX "wallet_bonus_credit_wallet_id_idx" ON "wallet_bonus_credit" USING btree ("wallet_id");
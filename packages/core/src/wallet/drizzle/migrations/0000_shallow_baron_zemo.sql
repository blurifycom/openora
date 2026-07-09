CREATE TYPE "public"."wallet_rail" AS ENUM('crypto', 'fiat');--> statement-breakpoint
CREATE TYPE "public"."wallet_transaction_status" AS ENUM('pending', 'processing', 'completed', 'failed', 'rejected', 'on_hold', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."wallet_transaction_type" AS ENUM('deposit', 'withdrawal', 'bet', 'win', 'loss', 'bonus', 'tip');--> statement-breakpoint
CREATE TABLE "auto_withdrawal_rule" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"threshold" numeric NOT NULL,
	"reason" text NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "auto_withdrawal_rule_user_id_unique" UNIQUE("user_id")
);
--> statement-breakpoint
CREATE TABLE "wallet" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"balance" numeric DEFAULT '0' NOT NULL,
	"currency" text DEFAULT 'USD' NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "wallet_user_id_unique" UNIQUE("user_id")
);
--> statement-breakpoint
CREATE TABLE "wallet_transaction" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"wallet_id" uuid NOT NULL,
	"type" "wallet_transaction_type" NOT NULL,
	"amount" numeric NOT NULL,
	"currency" text NOT NULL,
	"status" "wallet_transaction_status" DEFAULT 'pending' NOT NULL,
	"rail" "wallet_rail",
	"reviewed_by" uuid,
	"reviewed_at" timestamp with time zone,
	"review_reason" text,
	"provider_name" text,
	"provider_ref_id" text,
	"metadata" text,
	"idempotency_key" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "wallet_transaction" ADD CONSTRAINT "wallet_transaction_wallet_id_wallet_id_fk" FOREIGN KEY ("wallet_id") REFERENCES "public"."wallet"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "wallet_transaction_wallet_id_idx" ON "wallet_transaction" USING btree ("wallet_id");--> statement-breakpoint
CREATE INDEX "wallet_transaction_created_at_idx" ON "wallet_transaction" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "wallet_transaction_type_idx" ON "wallet_transaction" USING btree ("type");--> statement-breakpoint
CREATE INDEX "wallet_transaction_status_idx" ON "wallet_transaction" USING btree ("status");--> statement-breakpoint
CREATE INDEX "wallet_transaction_rail_idx" ON "wallet_transaction" USING btree ("rail");--> statement-breakpoint
CREATE INDEX "wallet_transaction_currency_idx" ON "wallet_transaction" USING btree ("currency");--> statement-breakpoint
CREATE INDEX "wallet_transaction_provider_ref_id_idx" ON "wallet_transaction" USING btree ("provider_ref_id");--> statement-breakpoint
CREATE UNIQUE INDEX "wallet_transaction_wallet_id_idempotency_key_idx" ON "wallet_transaction" USING btree ("wallet_id","idempotency_key") WHERE "wallet_transaction"."idempotency_key" IS NOT NULL;

CREATE TYPE "public"."wallet_deposit_status_event_status" AS ENUM('detected', 'failed', 'below_minimum');--> statement-breakpoint
CREATE TABLE "wallet_deposit_status_event" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider_name" text NOT NULL,
	"external_id" text NOT NULL,
	"status" "wallet_deposit_status_event_status" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "wallet_deposit_status_event_provider_external_id_status_idx" ON "wallet_deposit_status_event" USING btree ("provider_name","external_id","status");
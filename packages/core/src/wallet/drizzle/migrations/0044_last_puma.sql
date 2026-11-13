CREATE TYPE "public"."ledger_api_operation" AS ENUM('bet', 'win', 'reverse');--> statement-breakpoint
CREATE TABLE "ledger_api_request" (
	"provider_name" text NOT NULL,
	"provider_ref_id" text NOT NULL,
	"operation" "ledger_api_operation" NOT NULL,
	"fingerprint" text NOT NULL,
	"target_ref_id" text,
	"response" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ledger_api_request_provider_name_provider_ref_id_pk" PRIMARY KEY("provider_name","provider_ref_id")
);
--> statement-breakpoint
CREATE UNIQUE INDEX "ledger_api_request_target_ref_key" ON "ledger_api_request" USING btree ("provider_name","target_ref_id") WHERE "ledger_api_request"."target_ref_id" IS NOT NULL;
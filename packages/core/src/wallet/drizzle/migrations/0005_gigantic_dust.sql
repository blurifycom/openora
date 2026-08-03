CREATE TABLE "wallet_auto_withdrawal_config" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"singleton_key" text DEFAULT 'global' NOT NULL,
	"fiat_threshold" numeric(18, 8) NOT NULL,
	"crypto_threshold" numeric(18, 8) NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "wallet_auto_withdrawal_config_singletonKey_unique" UNIQUE("singleton_key")
);

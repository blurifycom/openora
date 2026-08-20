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
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "wallet_asset_currency_network_idx" ON "wallet_asset" USING btree ("currency","network");
CREATE TABLE "wallet_provider_vault" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"provider_name" text NOT NULL,
	"vault_account_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DROP INDEX "wallet_deposit_address_user_id_currency_idx";--> statement-breakpoint
DROP INDEX "wallet_deposit_address_address_idx";--> statement-breakpoint
ALTER TABLE "wallet_deposit_address" ADD COLUMN "network" text;--> statement-breakpoint
ALTER TABLE "wallet_deposit_address" ADD COLUMN "tag" text;--> statement-breakpoint
CREATE UNIQUE INDEX "wallet_provider_vault_user_id_provider_name_idx" ON "wallet_provider_vault" USING btree ("user_id","provider_name");--> statement-breakpoint
CREATE UNIQUE INDEX "wallet_provider_vault_provider_name_vault_account_id_idx" ON "wallet_provider_vault" USING btree ("provider_name","vault_account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "wallet_deposit_address_user_id_currency_network_idx" ON "wallet_deposit_address" USING btree ("user_id","currency","network") WHERE "wallet_deposit_address"."network" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "wallet_deposit_address_address_tag_idx" ON "wallet_deposit_address" USING btree ("address","tag") WHERE "wallet_deposit_address"."tag" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "wallet_deposit_address_user_id_currency_idx" ON "wallet_deposit_address" USING btree ("user_id","currency") WHERE "wallet_deposit_address"."network" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "wallet_deposit_address_address_idx" ON "wallet_deposit_address" USING btree ("address") WHERE "wallet_deposit_address"."tag" IS NULL;
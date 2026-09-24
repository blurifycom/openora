DROP INDEX "promo_grant_user_id_currency_created_at_idx";--> statement-breakpoint
DROP INDEX "promo_grant_entry_user_id_external_round_id_idx";--> statement-breakpoint
ALTER TABLE "promo_grant_entry" ADD COLUMN "provider_name" text;--> statement-breakpoint
CREATE INDEX "promo_grant_user_id_currency_expires_at_idx" ON "promo_grant" USING btree ("user_id","currency","expires_at") WHERE "promo_grant"."status" in ('pending', 'active');--> statement-breakpoint
CREATE INDEX "promo_grant_entry_user_id_currency_provider_name_external_round_id_idx" ON "promo_grant_entry" USING btree ("user_id","currency","provider_name","external_round_id") WHERE "promo_grant_entry"."external_round_id" is not null;
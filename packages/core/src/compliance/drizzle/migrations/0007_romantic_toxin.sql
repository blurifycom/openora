CREATE TYPE "public"."kyc_verification_tier" AS ENUM('basic', 'advanced');--> statement-breakpoint
DROP INDEX "kyc_verification_user_id_created_at_idx";--> statement-breakpoint
DROP INDEX "kyc_verification_reference_id_key";--> statement-breakpoint
ALTER TABLE "kyc_verification" ADD COLUMN "tier" "kyc_verification_tier" DEFAULT 'basic' NOT NULL;--> statement-breakpoint
CREATE INDEX "kyc_verification_user_id_tier_created_at_idx" ON "kyc_verification" USING btree ("user_id","tier","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "kyc_verification_user_id_reference_id_tier_key" ON "kyc_verification" USING btree ("user_id","reference_id","tier");
CREATE TYPE "public"."tag_key" AS ENUM('high_roller', 'vip', 'bonus_abuser', 'high_risk', 'inactive', 'large_depositor', 'self_excluded', 'kyc_pending', 'kyc_rejected', 'test_account');--> statement-breakpoint
DROP INDEX "tag_key_idx";--> statement-breakpoint
ALTER TABLE "tag" ALTER COLUMN "key" SET DATA TYPE "public"."tag_key" USING "key"::"public"."tag_key";

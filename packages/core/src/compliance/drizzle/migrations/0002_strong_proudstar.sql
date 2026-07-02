CREATE TYPE "public"."kyc_triggered_by" AS ENUM('submission', 'reverify_threshold', 'manual');--> statement-breakpoint
CREATE TYPE "public"."kyc_verification_status" AS ENUM('not_started', 'pending', 'verified', 'rejected', 'resubmission_requested', 'manually_overridden');--> statement-breakpoint
ALTER TABLE "kyc_verification" ALTER COLUMN "status" SET DATA TYPE "public"."kyc_verification_status" USING "status"::"public"."kyc_verification_status";--> statement-breakpoint
ALTER TABLE "kyc_verification" ALTER COLUMN "triggered_by" SET DATA TYPE "public"."kyc_triggered_by" USING "triggered_by"::"public"."kyc_triggered_by";--> statement-breakpoint
ALTER TABLE "kyc_verification" ADD COLUMN "trigger_deposits" numeric(18, 2);

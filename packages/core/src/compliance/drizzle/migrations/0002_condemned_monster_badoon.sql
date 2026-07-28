ALTER TYPE "public"."kyc_verification_status" ADD VALUE 'approved' BEFORE 'verified';--> statement-breakpoint
ALTER TABLE "kyc_verification" ADD COLUMN "risk_signals" jsonb;--> statement-breakpoint
ALTER TABLE "kyc_verification" ADD COLUMN "decision_received_at" timestamp with time zone;

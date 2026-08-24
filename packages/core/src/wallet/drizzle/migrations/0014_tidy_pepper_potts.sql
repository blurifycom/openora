ALTER TYPE "public"."wallet_job_run_status" ADD VALUE 'skipped' BEFORE 'failed';--> statement-breakpoint
ALTER TABLE "wallet_asset" ADD COLUMN "sweep_dust_threshold" numeric(38, 18);
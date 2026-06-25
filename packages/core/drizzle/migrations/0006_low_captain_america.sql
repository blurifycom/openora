CREATE TYPE "public"."wallet_rail" AS ENUM('fireblocks', 'psp');--> statement-breakpoint
ALTER TYPE "public"."wallet_transaction_status" ADD VALUE 'processing' BEFORE 'completed';--> statement-breakpoint
ALTER TYPE "public"."wallet_transaction_status" ADD VALUE 'rejected';--> statement-breakpoint
ALTER TABLE "wallet_transaction" ADD COLUMN "rail" "wallet_rail";--> statement-breakpoint
ALTER TABLE "wallet_transaction" ADD COLUMN "reviewed_by" uuid;--> statement-breakpoint
ALTER TABLE "wallet_transaction" ADD COLUMN "reviewed_at" timestamp;--> statement-breakpoint
ALTER TABLE "wallet_transaction" ADD COLUMN "review_reason" text;
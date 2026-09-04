CREATE TYPE "public"."limit_change_kind" AS ENUM('increase', 'removal');--> statement-breakpoint
DROP INDEX "user_limit_user_id_type_period_key";--> statement-breakpoint
ALTER TABLE "user_limit" ALTER COLUMN "amount" SET DATA TYPE numeric(38, 18);--> statement-breakpoint
ALTER TABLE "user_limit" ADD COLUMN "currency" text;--> statement-breakpoint
ALTER TABLE "user_limit" ADD COLUMN "pending_kind" "limit_change_kind";--> statement-breakpoint
ALTER TABLE "user_limit" ADD COLUMN "pending_amount" numeric(38, 18);--> statement-breakpoint
ALTER TABLE "user_limit" ADD COLUMN "pending_minutes" integer;--> statement-breakpoint
ALTER TABLE "user_limit" ADD COLUMN "pending_currency" text;--> statement-breakpoint
ALTER TABLE "user_limit" ADD COLUMN "pending_requested_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "user_limit" ADD COLUMN "pending_effective_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "user_limit" ADD COLUMN "pending_expires_at" timestamp with time zone;--> statement-breakpoint
CREATE UNIQUE INDEX "user_limit_user_id_type_period_currency_key" ON "user_limit" USING btree ("user_id","type","period","currency");--> statement-breakpoint
CREATE INDEX "user_limit_pending_expires_at_idx" ON "user_limit" USING btree ("pending_expires_at");
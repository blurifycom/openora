CREATE TYPE "public"."auto_logout_duration" AS ENUM('15m', '1h', '24h', '7d', '30d', 'never');--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "auto_logout_duration" "auto_logout_duration" DEFAULT 'never' NOT NULL;--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "require_two_factor_on_login" boolean DEFAULT false NOT NULL;
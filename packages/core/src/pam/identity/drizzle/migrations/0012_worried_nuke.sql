CREATE TYPE "public"."two_factor_method" AS ENUM('app', 'email', 'sms');--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "two_factor_method" "two_factor_method";

CREATE TYPE "public"."chat_message_type" AS ENUM('user', 'system');--> statement-breakpoint
ALTER TABLE "chat_message" ADD COLUMN "type" "chat_message_type" DEFAULT 'user' NOT NULL;--> statement-breakpoint
ALTER TABLE "chat_message" ADD COLUMN "metadata" jsonb;
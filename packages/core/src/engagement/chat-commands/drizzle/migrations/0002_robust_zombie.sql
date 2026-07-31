CREATE TYPE "public"."chat_command_type" AS ENUM('mention', 'profile', 'gift', 'rain', 'donate', 'block', 'ignore');--> statement-breakpoint
CREATE TABLE "chat_command_idempotency" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor_id" uuid NOT NULL,
	"command_type" "chat_command_type" NOT NULL,
	"idempotency_key" uuid NOT NULL,
	"amount" numeric(18, 8) NOT NULL,
	"result" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "chat_command_idempotency_actor_type_key_idx" ON "chat_command_idempotency" USING btree ("actor_id","command_type","idempotency_key");
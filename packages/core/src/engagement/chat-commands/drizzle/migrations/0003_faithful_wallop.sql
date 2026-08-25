CREATE TABLE "chat_command_idempotency" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor_id" uuid NOT NULL,
	"command_type" text NOT NULL,
	"idempotency_key" uuid NOT NULL,
	"fingerprint" text NOT NULL,
	"result" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chat_command_idempotency_actor_command_key_unique" UNIQUE("actor_id","command_type","idempotency_key")
);

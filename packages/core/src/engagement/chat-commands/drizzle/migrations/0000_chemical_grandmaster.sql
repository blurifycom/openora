CREATE TABLE "chat_command_config" (
	"key" text PRIMARY KEY NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"label" text NOT NULL,
	"description" text,
	"config" jsonb,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "chat_command_config" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"label" text NOT NULL,
	"description" text,
	"config" jsonb,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chat_command_config_key_unique" UNIQUE("key")
);
--> statement-breakpoint
CREATE TABLE "chat_gift" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"message_id" uuid NOT NULL,
	"sender_id" uuid NOT NULL,
	"sender_username" text NOT NULL,
	"amount" numeric(18, 8) NOT NULL,
	"currency" text NOT NULL,
	"room_id" uuid NOT NULL,
	"claimed_by" uuid,
	"claimed_by_username" text,
	"claimed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);

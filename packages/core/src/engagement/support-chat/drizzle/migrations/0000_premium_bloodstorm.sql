CREATE TABLE "support_chat_customer" (
	"player_id" uuid PRIMARY KEY NOT NULL,
	"provider_customer_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "support_chat_customer_provider_customer_id_unique" UNIQUE("provider_customer_id")
);

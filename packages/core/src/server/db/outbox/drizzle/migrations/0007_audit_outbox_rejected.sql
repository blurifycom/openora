CREATE TABLE "audit_outbox_rejected" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"outbox_id" bigint NOT NULL,
	"event_id" uuid NOT NULL,
	"entry" jsonb NOT NULL,
	"error" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"rejected_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "audit_outbox_rejected_event_id_unique" UNIQUE("event_id")
);

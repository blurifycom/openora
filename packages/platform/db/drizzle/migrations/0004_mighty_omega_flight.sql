CREATE TABLE "event_outbox" (
	"eventId" text PRIMARY KEY NOT NULL,
	"topic" text NOT NULL,
	"payload" jsonb NOT NULL,
	"schemaVersion" integer DEFAULT 1 NOT NULL,
	"tenantId" text,
	"traceId" text,
	"orderingKey" text,
	"occurredAt" timestamp with time zone NOT NULL,
	"publishedAt" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "event_outbox_pending_idx" ON "event_outbox" USING btree ("publishedAt","occurredAt");
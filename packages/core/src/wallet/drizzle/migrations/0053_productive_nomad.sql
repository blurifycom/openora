CREATE TABLE "ledger_projection_heartbeat" (
	"projection" text PRIMARY KEY NOT NULL,
	"beat_at" timestamp with time zone DEFAULT now() NOT NULL
);

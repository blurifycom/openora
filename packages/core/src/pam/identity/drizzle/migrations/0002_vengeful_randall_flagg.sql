ALTER TABLE "user" ADD COLUMN "rg_blocked" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "rg_blocked_until" timestamp with time zone;

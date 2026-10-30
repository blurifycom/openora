ALTER TABLE "user" ADD COLUMN "withdrawal_pin_failed_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "withdrawal_pin_locked_until" timestamp with time zone;
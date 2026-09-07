ALTER TABLE "user" ADD COLUMN "withdrawal_pin_hash" text;--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "withdrawal_pin_set_at" timestamp with time zone;
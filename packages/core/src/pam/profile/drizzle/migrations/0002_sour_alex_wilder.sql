ALTER TABLE "player" ADD COLUMN "terms_version" text;--> statement-breakpoint
ALTER TABLE "player" ADD COLUMN "terms_accepted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "player" ADD COLUMN "age_accepted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "player" ADD COLUMN "registration_ip" text;--> statement-breakpoint
ALTER TABLE "player" ADD COLUMN "registration_user_agent" text;
ALTER TABLE "player" ADD COLUMN "terms_version" text;--> statement-breakpoint
ALTER TABLE "player" ADD COLUMN "terms_accepted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "player" ADD COLUMN "age_accepted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "player" ADD COLUMN "registration_ip" text;--> statement-breakpoint
ALTER TABLE "player" ADD COLUMN "registration_user_agent" text;--> statement-breakpoint
DROP INDEX "player_name_trgm_idx";--> statement-breakpoint
ALTER TABLE "player" DROP COLUMN "display_name";

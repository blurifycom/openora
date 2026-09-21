CREATE TYPE "public"."game_category_game_source" AS ENUM('manual', 'rule');--> statement-breakpoint
CREATE TYPE "public"."game_category_membership_mode" AS ENUM('manual', 'rule');--> statement-breakpoint
ALTER TABLE "game_category" ADD COLUMN "membership_mode" "game_category_membership_mode" DEFAULT 'manual' NOT NULL;--> statement-breakpoint
ALTER TABLE "game_category" ADD COLUMN "membership_rule" jsonb;--> statement-breakpoint
ALTER TABLE "game_category" ADD COLUMN "membership_evaluated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "game_category" ADD COLUMN "membership_attempted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "game_category" ADD COLUMN "membership_last_error" text;--> statement-breakpoint
ALTER TABLE "game_category_game" ADD COLUMN "source" "game_category_game_source" DEFAULT 'manual' NOT NULL;--> statement-breakpoint
ALTER TABLE "game_category" ADD CONSTRAINT "game_category_membership_rule_check" CHECK ("game_category"."membership_mode" = 'manual' OR "game_category"."membership_rule" IS NOT NULL);
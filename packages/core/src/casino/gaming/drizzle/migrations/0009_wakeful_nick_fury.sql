CREATE TYPE "public"."game_sort_direction" AS ENUM('asc', 'desc');--> statement-breakpoint
DROP INDEX "game_category_game_category_id_idx";--> statement-breakpoint
ALTER TABLE "game_category" ADD COLUMN "sort_key" text DEFAULT 'manual' NOT NULL;--> statement-breakpoint
ALTER TABLE "game_category" ADD COLUMN "sort_direction" "game_sort_direction";--> statement-breakpoint
ALTER TABLE "game_category" ADD COLUMN "sort_params" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "game_category" ADD COLUMN "rank_seq" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "game_category" ADD COLUMN "rank_dirty_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "game_category" ADD COLUMN "ranked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "game_category_game" ADD COLUMN "position" integer;--> statement-breakpoint
ALTER TABLE "game_category_game" ADD COLUMN "rank" integer;--> statement-breakpoint
ALTER TABLE "game_category_game" ADD COLUMN "pinned_position" integer;--> statement-breakpoint
CREATE INDEX "game_category_game_category_id_rank_idx" ON "game_category_game" USING btree ("category_id","rank");--> statement-breakpoint
CREATE UNIQUE INDEX "game_category_game_category_id_pinned_position_key" ON "game_category_game" USING btree ("category_id","pinned_position") WHERE "game_category_game"."pinned_position" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "game_category_game" ADD CONSTRAINT "game_category_game_pinned_position_check" CHECK ("game_category_game"."pinned_position" >= 0);
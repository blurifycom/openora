CREATE TYPE "public"."game_review_status" AS ENUM('pending', 'auto_approved', 'approved', 'declined');--> statement-breakpoint
ALTER TABLE "game" ADD COLUMN "review_status" "game_review_status" DEFAULT 'approved' NOT NULL;--> statement-breakpoint
ALTER TABLE "game" ADD COLUMN "reviewed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "game_provider" ADD COLUMN "auto_approve_new_games" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE INDEX "game_provider_id_pending_idx" ON "game" USING btree ("provider_id") WHERE "game"."review_status" = 'pending';--> statement-breakpoint
ALTER TABLE "game" ADD CONSTRAINT "game_review_status_active_check" CHECK (NOT "game"."is_active" OR "game"."review_status" IN ('approved', 'auto_approved'));
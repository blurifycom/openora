ALTER TYPE "public"."tag_key" ADD VALUE 'multi_account';--> statement-breakpoint
ALTER TYPE "public"."tag_key" ADD VALUE 'level';--> statement-breakpoint
ALTER TABLE "player_tag" ADD COLUMN "assign_metadata" jsonb;

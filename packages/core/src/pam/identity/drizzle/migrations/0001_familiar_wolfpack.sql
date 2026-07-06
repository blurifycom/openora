DO $$ BEGIN
 CREATE TYPE "public"."user_theme" AS ENUM('light', 'dark', 'system');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN IF NOT EXISTS "theme" "user_theme" DEFAULT 'system' NOT NULL;--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN IF NOT EXISTS "language" text DEFAULT 'en' NOT NULL;

-- PostgreSQL cannot remove an enum label. The preceding migration maps all
-- legacy rows, then this migration rebuilds the enum with the supported set.
ALTER TABLE "chat_room" ALTER COLUMN "category" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "chat_room" ALTER COLUMN "category" TYPE text USING "category"::text;--> statement-breakpoint
DROP TYPE "public"."chat_room_category";--> statement-breakpoint
CREATE TYPE "public"."chat_room_category" AS ENUM('games-sports', 'regions', 'languages', 'private-channels');--> statement-breakpoint
ALTER TABLE "chat_room" ALTER COLUMN "category" TYPE "public"."chat_room_category" USING "category"::"public"."chat_room_category";--> statement-breakpoint
ALTER TABLE "chat_room" ALTER COLUMN "category" SET DEFAULT 'games-sports';

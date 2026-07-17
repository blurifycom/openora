CREATE TYPE "public"."chat_room_category" AS ENUM('games-sports', 'regions', 'languages', 'private-channels');--> statement-breakpoint
ALTER TABLE "chat_room" ADD COLUMN "category" "chat_room_category" DEFAULT 'games-sports' NOT NULL;

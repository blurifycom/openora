CREATE TYPE "public"."chat_moderation_scope" AS ENUM('__global', '__all_public', '__all', 'room');--> statement-breakpoint
ALTER TABLE "chat_mute" ADD COLUMN "scope" "chat_moderation_scope" DEFAULT '__global' NOT NULL;--> statement-breakpoint
ALTER TABLE "chat_platform_ban" ADD COLUMN "scope" "chat_moderation_scope" DEFAULT '__all_public' NOT NULL;--> statement-breakpoint
ALTER TABLE "chat_platform_ban" ADD COLUMN "room_id" uuid;--> statement-breakpoint
ALTER TABLE "chat_platform_ban" ADD COLUMN "expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "chat_platform_ban" ADD CONSTRAINT "chat_platform_ban_room_id_chat_room_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."chat_room"("id") ON DELETE no action ON UPDATE no action;
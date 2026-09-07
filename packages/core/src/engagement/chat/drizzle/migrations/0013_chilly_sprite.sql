ALTER TABLE "chat_message" DROP CONSTRAINT "chat_message_room_id_chat_room_id_fk";
--> statement-breakpoint
ALTER TABLE "chat_platform_ban" DROP CONSTRAINT "chat_platform_ban_room_id_chat_room_id_fk";
--> statement-breakpoint
ALTER TABLE "chat_message" ADD CONSTRAINT "chat_message_room_id_chat_room_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."chat_room"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_platform_ban" ADD CONSTRAINT "chat_platform_ban_room_id_chat_room_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."chat_room"("id") ON DELETE cascade ON UPDATE no action;
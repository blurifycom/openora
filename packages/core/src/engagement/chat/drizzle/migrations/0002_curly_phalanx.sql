ALTER TABLE "chat_room" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "chat_room_deleted_at_idx" ON "chat_room" USING btree ("deleted_at");--> statement-breakpoint
CREATE INDEX "chat_room_creator_public_deleted_at_idx" ON "chat_room" USING btree ("creator_id","is_public","deleted_at");

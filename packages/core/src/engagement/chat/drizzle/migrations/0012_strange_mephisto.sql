ALTER TABLE "chat_room" ADD COLUMN "scheduled_deletion_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "chat_room_member" ADD COLUMN "account_closed_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "chat_room_scheduled_deletion_idx" ON "chat_room" USING btree ("scheduled_deletion_at") WHERE "chat_room"."scheduled_deletion_at" IS NOT NULL;
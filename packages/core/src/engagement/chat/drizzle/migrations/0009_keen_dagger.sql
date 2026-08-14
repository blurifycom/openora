ALTER TABLE "chat_message" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "chat_msg_deleted_at_idx" ON "chat_message" USING btree ("deleted_at");
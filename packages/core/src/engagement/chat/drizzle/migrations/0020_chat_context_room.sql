CREATE TYPE "public"."chat_room_kind" AS ENUM('standard', 'context');--> statement-breakpoint
ALTER TABLE "chat_room" ADD COLUMN "kind" "chat_room_kind" DEFAULT 'standard' NOT NULL;--> statement-breakpoint
ALTER TABLE "chat_room" ADD COLUMN "context_ref" text;--> statement-breakpoint
CREATE UNIQUE INDEX "chat_room_context_ref_key" ON "chat_room" USING btree ("context_ref");--> statement-breakpoint
ALTER TABLE "chat_room" ADD CONSTRAINT "chat_room_context_kind_check" CHECK (("chat_room"."kind" = 'context') = ("chat_room"."context_ref" IS NOT NULL) AND ("chat_room"."kind" = 'standard' OR NOT "chat_room"."is_public"));
CREATE TYPE "public"."chat_room_category" AS ENUM('games-sports', 'regions', 'languages', 'private-channels');--> statement-breakpoint
CREATE TYPE "public"."chat_room_role" AS ENUM('member', 'moderator');--> statement-breakpoint
CREATE TABLE "chat_room_ban" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"room_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"banned_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chat_room_member" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"room_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" "chat_room_role" DEFAULT 'member' NOT NULL,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "chat_room" ADD COLUMN "category" "chat_room_category" DEFAULT 'games-sports' NOT NULL;--> statement-breakpoint
ALTER TABLE "chat_room" ADD COLUMN "join_code" text;--> statement-breakpoint
ALTER TABLE "chat_room" ADD COLUMN "creator_id" uuid;--> statement-breakpoint
ALTER TABLE "chat_room" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "chat_room_ban" ADD CONSTRAINT "chat_room_ban_room_id_chat_room_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."chat_room"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_room_member" ADD CONSTRAINT "chat_room_member_room_id_chat_room_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."chat_room"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "chat_room_ban_room_user_key" ON "chat_room_ban" USING btree ("room_id","user_id");--> statement-breakpoint
CREATE INDEX "chat_room_ban_room_idx" ON "chat_room_ban" USING btree ("room_id");--> statement-breakpoint
CREATE UNIQUE INDEX "chat_room_member_room_user_key" ON "chat_room_member" USING btree ("room_id","user_id");--> statement-breakpoint
CREATE INDEX "chat_room_member_room_idx" ON "chat_room_member" USING btree ("room_id");--> statement-breakpoint
CREATE INDEX "chat_room_member_user_idx" ON "chat_room_member" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "chat_room_join_code_key" ON "chat_room" USING btree ("join_code");--> statement-breakpoint
CREATE INDEX "chat_room_deleted_at_idx" ON "chat_room" USING btree ("deleted_at");--> statement-breakpoint
CREATE INDEX "chat_room_creator_public_deleted_at_idx" ON "chat_room" USING btree ("creator_id","is_public","deleted_at");
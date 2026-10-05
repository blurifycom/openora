CREATE TYPE "public"."chat_room_invite_status" AS ENUM('pending', 'accepted', 'declined', 'expired');--> statement-breakpoint
CREATE TABLE "chat_room_invite" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"room_id" uuid NOT NULL,
	"inviter_id" uuid NOT NULL,
	"invitee_id" uuid NOT NULL,
	"status" "chat_room_invite_status" DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"responded_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "chat_room_invite" ADD CONSTRAINT "chat_room_invite_room_id_chat_room_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."chat_room"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "chat_room_invite_pending_room_invitee_key" ON "chat_room_invite" USING btree ("room_id","invitee_id") WHERE "chat_room_invite"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "chat_room_invite_invitee_status_idx" ON "chat_room_invite" USING btree ("invitee_id","status");--> statement-breakpoint
CREATE INDEX "chat_room_invite_room_idx" ON "chat_room_invite" USING btree ("room_id");
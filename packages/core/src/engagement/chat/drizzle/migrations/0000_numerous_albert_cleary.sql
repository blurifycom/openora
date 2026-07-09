CREATE TABLE "chat_message" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"room_id" uuid,
	"user_id" uuid NOT NULL,
	"username" text NOT NULL,
	"content" text NOT NULL,
	"is_deleted" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chat_room" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"is_public" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chat_user_block" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"blocker_id" uuid NOT NULL,
	"blocked_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "chat_message" ADD CONSTRAINT "chat_message_room_id_chat_room_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."chat_room"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "chat_msg_room_id_created_at_idx" ON "chat_message" USING btree ("room_id","created_at");--> statement-breakpoint
CREATE INDEX "chat_msg_created_at_idx" ON "chat_message" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "chat_room_slug_key" ON "chat_room" USING btree ("slug");--> statement-breakpoint
CREATE UNIQUE INDEX "chat_user_block_pair_key" ON "chat_user_block" USING btree ("blocker_id","blocked_id");--> statement-breakpoint
CREATE INDEX "chat_user_block_blocker_idx" ON "chat_user_block" USING btree ("blocker_id");

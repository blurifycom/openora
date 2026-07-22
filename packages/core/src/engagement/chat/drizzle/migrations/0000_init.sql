DO $$ BEGIN CREATE TYPE "public"."chat_room_category" AS ENUM('games-sports', 'regions', 'languages', 'private-channels'); EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN CREATE TYPE "public"."chat_room_role" AS ENUM('member', 'moderator'); EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
CREATE TABLE "chat_room" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"category" "chat_room_category" DEFAULT 'games-sports' NOT NULL,
	"is_public" boolean DEFAULT true NOT NULL,
	"join_code" text,
	"creator_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
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
CREATE TABLE "chat_user_block" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"blocker_id" uuid NOT NULL,
	"blocked_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
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
ALTER TABLE "chat_message" ADD CONSTRAINT "chat_message_room_id_chat_room_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."chat_room"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "chat_room_ban" ADD CONSTRAINT "chat_room_ban_room_id_chat_room_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."chat_room"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "chat_room_member" ADD CONSTRAINT "chat_room_member_room_id_chat_room_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."chat_room"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "chat_msg_room_id_created_at_idx" ON "chat_message" USING btree ("room_id","created_at");
--> statement-breakpoint
CREATE INDEX "chat_msg_created_at_idx" ON "chat_message" USING btree ("created_at");
--> statement-breakpoint
CREATE UNIQUE INDEX "chat_room_slug_key" ON "chat_room" USING btree ("slug");
--> statement-breakpoint
CREATE UNIQUE INDEX "chat_room_join_code_key" ON "chat_room" USING btree ("join_code");
--> statement-breakpoint
CREATE INDEX "chat_room_deleted_at_idx" ON "chat_room" USING btree ("deleted_at");
--> statement-breakpoint
CREATE INDEX "chat_room_creator_public_deleted_at_idx" ON "chat_room" USING btree ("creator_id","is_public","deleted_at");
--> statement-breakpoint
CREATE UNIQUE INDEX "chat_user_block_pair_key" ON "chat_user_block" USING btree ("blocker_id","blocked_id");
--> statement-breakpoint
CREATE INDEX "chat_user_block_blocker_idx" ON "chat_user_block" USING btree ("blocker_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "chat_room_ban_room_user_key" ON "chat_room_ban" USING btree ("room_id","user_id");
--> statement-breakpoint
CREATE INDEX "chat_room_ban_room_idx" ON "chat_room_ban" USING btree ("room_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "chat_room_member_room_user_key" ON "chat_room_member" USING btree ("room_id","user_id");
--> statement-breakpoint
CREATE INDEX "chat_room_member_room_idx" ON "chat_room_member" USING btree ("room_id");
--> statement-breakpoint
CREATE INDEX "chat_room_member_user_idx" ON "chat_room_member" USING btree ("user_id");

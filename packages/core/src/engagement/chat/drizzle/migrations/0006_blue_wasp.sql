CREATE TABLE "chat_mute" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"room_id" uuid,
	"muted_by" uuid NOT NULL,
	"reason" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone,
	"lifted_at" timestamp with time zone,
	"lifted_by" uuid
);
--> statement-breakpoint
CREATE TABLE "chat_platform_ban" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"banned_by" uuid NOT NULL,
	"reason" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lifted_at" timestamp with time zone,
	"lifted_by" uuid
);
--> statement-breakpoint
CREATE INDEX "chat_mute_user_room_idx" ON "chat_mute" USING btree ("user_id","room_id");--> statement-breakpoint
CREATE INDEX "chat_mute_expires_at_idx" ON "chat_mute" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "chat_platform_ban_active_user_key" ON "chat_platform_ban" USING btree ("user_id") WHERE "chat_platform_ban"."lifted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "chat_platform_ban_user_idx" ON "chat_platform_ban" USING btree ("user_id");

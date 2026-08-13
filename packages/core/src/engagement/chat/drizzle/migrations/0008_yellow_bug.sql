CREATE TABLE "chat_room_configuration" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"room_id" uuid NOT NULL,
	"slow_mode" boolean DEFAULT false NOT NULL,
	"slow_mode_seconds" integer DEFAULT 0 NOT NULL,
	"read_only_mode" boolean DEFAULT false NOT NULL,
	"only_invited_can_join" boolean DEFAULT false NOT NULL,
	"lock_room" boolean DEFAULT false NOT NULL,
	"moderator_invite" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chat_room_mute" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"room_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"muted_by" uuid NOT NULL,
	"reason" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone,
	"lifted_at" timestamp with time zone,
	"lifted_by" uuid
);
--> statement-breakpoint
CREATE TABLE "chat_room_remove" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"room_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"removed_by" uuid NOT NULL,
	"reason" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chat_room_rule" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"room_id" uuid NOT NULL,
	"created_by" uuid NOT NULL,
	"order_num" integer NOT NULL,
	"content" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DROP INDEX "chat_room_ban_room_user_key";--> statement-breakpoint
ALTER TABLE "chat_room_ban" ADD COLUMN "expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "chat_room_ban" ADD COLUMN "lifted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "chat_room_ban" ADD COLUMN "lifted_by" uuid;--> statement-breakpoint
ALTER TABLE "chat_room_configuration" ADD CONSTRAINT "chat_room_configuration_room_id_chat_room_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."chat_room"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_room_mute" ADD CONSTRAINT "chat_room_mute_room_id_chat_room_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."chat_room"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_room_remove" ADD CONSTRAINT "chat_room_remove_room_id_chat_room_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."chat_room"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_room_rule" ADD CONSTRAINT "chat_room_rule_room_id_chat_room_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."chat_room"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "chat_room_configuration_room_key" ON "chat_room_configuration" USING btree ("room_id");--> statement-breakpoint
CREATE UNIQUE INDEX "chat_room_mute_active_room_user_key" ON "chat_room_mute" USING btree ("room_id","user_id") WHERE "chat_room_mute"."lifted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "chat_room_mute_room_user_idx" ON "chat_room_mute" USING btree ("room_id","user_id");--> statement-breakpoint
CREATE INDEX "chat_room_mute_expires_at_idx" ON "chat_room_mute" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "chat_room_remove_room_created_at_idx" ON "chat_room_remove" USING btree ("room_id","created_at");--> statement-breakpoint
CREATE INDEX "chat_room_remove_user_idx" ON "chat_room_remove" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "chat_room_rule_room_order_idx" ON "chat_room_rule" USING btree ("room_id","order_num");--> statement-breakpoint
CREATE INDEX "chat_room_rule_room_idx" ON "chat_room_rule" USING btree ("room_id");--> statement-breakpoint
CREATE UNIQUE INDEX "chat_room_ban_active_room_user_key" ON "chat_room_ban" USING btree ("room_id","user_id") WHERE "chat_room_ban"."lifted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "chat_room_ban_user_idx" ON "chat_room_ban" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "chat_room_ban_expires_at_idx" ON "chat_room_ban" USING btree ("expires_at");
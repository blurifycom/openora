CREATE TABLE "chat_player_cooldown" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"room_id" uuid,
	"scope" "chat_moderation_scope" NOT NULL,
	"cooldown_seconds" integer NOT NULL,
	"reason" text NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone,
	"lifted_at" timestamp with time zone,
	"lifted_by" uuid,
	"expiry_recorded_at" timestamp with time zone,
	CONSTRAINT "chat_player_cooldown_seconds_check" CHECK ("chat_player_cooldown"."cooldown_seconds" > 0 AND "chat_player_cooldown"."cooldown_seconds" <= 86400),
	CONSTRAINT "chat_player_cooldown_room_scope_check" CHECK (("chat_player_cooldown"."scope" = 'room') = ("chat_player_cooldown"."room_id" IS NOT NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "chat_player_cooldown_active_scope_key" ON "chat_player_cooldown" USING btree ("user_id","scope") WHERE "chat_player_cooldown"."lifted_at" IS NULL AND "chat_player_cooldown"."room_id" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "chat_player_cooldown_active_room_key" ON "chat_player_cooldown" USING btree ("user_id","scope","room_id") WHERE "chat_player_cooldown"."lifted_at" IS NULL AND "chat_player_cooldown"."room_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "chat_player_cooldown_user_idx" ON "chat_player_cooldown" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "chat_player_cooldown_expiry_due_idx" ON "chat_player_cooldown" USING btree ("expires_at") WHERE "chat_player_cooldown"."expires_at" IS NOT NULL AND "chat_player_cooldown"."expiry_recorded_at" IS NULL AND ("chat_player_cooldown"."lifted_at" IS NULL OR "chat_player_cooldown"."lifted_at" = "chat_player_cooldown"."expires_at");
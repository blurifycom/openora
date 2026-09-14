CREATE TYPE "public"."game_tag_type" AS ENUM('system', 'custom');--> statement-breakpoint
CREATE TYPE "public"."game_tag_visibility" AS ENUM('visible', 'invisible');--> statement-breakpoint
CREATE TABLE "game_tag" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"type" "game_tag_type" DEFAULT 'custom' NOT NULL,
	"visibility" "game_tag_visibility" DEFAULT 'invisible' NOT NULL,
	"badge_settings" jsonb DEFAULT '{"badgeColor":"#3377ff","textColor":"#ffffff"}'::jsonb NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "game_tag_game" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"game_id" uuid NOT NULL,
	"tag_id" uuid NOT NULL
);
--> statement-breakpoint
ALTER TABLE "game_tag_game" ADD CONSTRAINT "game_tag_game_game_id_game_id_fk" FOREIGN KEY ("game_id") REFERENCES "public"."game"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "game_tag_game" ADD CONSTRAINT "game_tag_game_tag_id_game_tag_id_fk" FOREIGN KEY ("tag_id") REFERENCES "public"."game_tag"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "game_tag_name_key" ON "game_tag" USING btree ("name");--> statement-breakpoint
CREATE INDEX "game_tag_type_idx" ON "game_tag" USING btree ("type");--> statement-breakpoint
CREATE INDEX "game_tag_visibility_idx" ON "game_tag" USING btree ("visibility");--> statement-breakpoint
CREATE UNIQUE INDEX "game_tag_game_key" ON "game_tag_game" USING btree ("game_id","tag_id");--> statement-breakpoint
CREATE INDEX "game_tag_game_tag_id_idx" ON "game_tag_game" USING btree ("tag_id");
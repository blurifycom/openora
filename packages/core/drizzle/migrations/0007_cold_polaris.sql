CREATE TYPE "public"."tag_assign_remove_source" AS ENUM('scheduled', 'manual');--> statement-breakpoint
CREATE TABLE "player_tag" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"player_id" uuid NOT NULL,
	"tag_id" uuid NOT NULL,
	"assign_reason" text NOT NULL,
	"assign_actor" "tag_assign_remove_source" NOT NULL,
	"assign_actor_user_id" uuid NOT NULL,
	"removed_at" timestamp with time zone,
	"removal_reason" text,
	"removal_actor" "tag_assign_remove_source",
	"removal_actor_user_id" uuid,
	"updated_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tag" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"color" text NOT NULL,
	"description" text,
	"is_sticky" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tag_color_hex_check" CHECK ("tag"."color" ~ '^#[0-9A-Fa-f]{6}$')
);
--> statement-breakpoint
ALTER TABLE "player_tag" ADD CONSTRAINT "player_tag_tag_id_tag_id_fk" FOREIGN KEY ("tag_id") REFERENCES "public"."tag"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "player_tag_player_tag_idx" ON "player_tag" USING btree ("player_id","tag_id");--> statement-breakpoint
CREATE INDEX "tag_key_idx" ON "tag" USING btree ("key");

CREATE TYPE "public"."game_round_status" AS ENUM('active', 'completed', 'cancelled');--> statement-breakpoint
CREATE TABLE "game" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"provider" text NOT NULL,
	"category" text NOT NULL,
	"thumbnail_url" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "game_round" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"game_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"status" "game_round_status" DEFAULT 'active' NOT NULL,
	"bet_amount" numeric DEFAULT '0' NOT NULL,
	"win_amount" numeric DEFAULT '0' NOT NULL,
	"currency" text NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "game_round" ADD CONSTRAINT "game_round_game_id_game_id_fk" FOREIGN KEY ("game_id") REFERENCES "public"."game"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "game_round_user_id_idx" ON "game_round" USING btree ("user_id");

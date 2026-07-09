CREATE TYPE "public"."tag_assign_remove_source" AS ENUM('scheduled', 'manual');--> statement-breakpoint
CREATE TYPE "public"."tag_key" AS ENUM('high_roller', 'vip', 'bonus_abuser', 'high_risk', 'inactive', 'large_depositor', 'self_excluded', 'kyc_pending', 'kyc_rejected', 'test_account');--> statement-breakpoint
CREATE TABLE "player_tag" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"player_id" uuid NOT NULL,
	"tag_id" uuid NOT NULL,
	"assign_reason" text NOT NULL,
	"assign_actor" "tag_assign_remove_source" NOT NULL,
	"assign_actor_user_id" uuid,
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
	"key" "tag_key" NOT NULL,
	"is_sticky" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tag_key_unique" UNIQUE("key")
);
--> statement-breakpoint
CREATE TABLE "tag_rule" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tag_id" uuid NOT NULL,
	"is_enabled" boolean DEFAULT false NOT NULL,
	"threshold_amount" numeric,
	"threshold_days" integer,
	"threshold_count" integer,
	"updated_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tag_rule_tagId_unique" UNIQUE("tag_id")
);
--> statement-breakpoint
ALTER TABLE "player_tag" ADD CONSTRAINT "player_tag_tag_id_tag_id_fk" FOREIGN KEY ("tag_id") REFERENCES "public"."tag"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tag_rule" ADD CONSTRAINT "tag_rule_tag_id_tag_id_fk" FOREIGN KEY ("tag_id") REFERENCES "public"."tag"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "player_tag_player_tag_idx" ON "player_tag" USING btree ("player_id","tag_id");

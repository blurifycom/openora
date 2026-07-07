CREATE TYPE "public"."rg_exclusion_kind" AS ENUM('cooling_off', 'self_exclusion');--> statement-breakpoint
CREATE TYPE "public"."rg_exclusion_status" AS ENUM('active', 'lifted', 'expired');--> statement-breakpoint
CREATE TYPE "public"."rg_flag_status" AS ENUM('active', 'cleared');--> statement-breakpoint
CREATE TYPE "public"."rg_flag_type" AS ENUM('limit_threshold', 'session_time', 'self_excluded_login');--> statement-breakpoint
CREATE TABLE "rg_exclusion" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" "rg_exclusion_kind" NOT NULL,
	"status" "rg_exclusion_status" DEFAULT 'active' NOT NULL,
	"reason" text NOT NULL,
	"permanent" boolean DEFAULT false NOT NULL,
	"starts_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone,
	"lifted_at" timestamp with time zone,
	"lifted_reason" text,
	"lifted_by" uuid,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rg_flag" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"flag_type" "rg_flag_type" NOT NULL,
	"limit_type" text,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" "rg_flag_status" DEFAULT 'active' NOT NULL,
	"flagged_at" timestamp with time zone DEFAULT now() NOT NULL,
	"cleared_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX "rg_exclusion_user_id_idx" ON "rg_exclusion" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "rg_exclusion_user_id_status_idx" ON "rg_exclusion" USING btree ("user_id","status");--> statement-breakpoint
CREATE INDEX "rg_exclusion_kind_status_idx" ON "rg_exclusion" USING btree ("kind","status");--> statement-breakpoint
CREATE UNIQUE INDEX "rg_exclusion_active_kind_key" ON "rg_exclusion" USING btree ("user_id","kind") WHERE "rg_exclusion"."status" = 'active';--> statement-breakpoint
CREATE INDEX "rg_flag_status_flagged_at_idx" ON "rg_flag" USING btree ("status","flagged_at");--> statement-breakpoint
CREATE INDEX "rg_flag_user_id_idx" ON "rg_flag" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "rg_flag_flag_type_idx" ON "rg_flag" USING btree ("flag_type");

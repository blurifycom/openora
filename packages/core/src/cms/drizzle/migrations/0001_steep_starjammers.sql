CREATE TYPE "public"."banner_layout" AS ENUM('carousel', 'grid', 'single');--> statement-breakpoint
CREATE TABLE "banner_configuration" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"placement" text NOT NULL,
	"layout" "banner_layout" NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "banner_image" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"banner_configuration_id" uuid NOT NULL,
	"sort_order" integer NOT NULL,
	"locale" text DEFAULT 'default' NOT NULL,
	"desktop_image_url" text NOT NULL,
	"mobile_image_url" text NOT NULL,
	"link_url" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
DROP TABLE "banner" CASCADE;--> statement-breakpoint
ALTER TABLE "banner_image" ADD CONSTRAINT "banner_image_banner_configuration_id_banner_configuration_id_fk" FOREIGN KEY ("banner_configuration_id") REFERENCES "public"."banner_configuration"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "banner_configuration_placement_idx" ON "banner_configuration" USING btree ("placement");--> statement-breakpoint
CREATE UNIQUE INDEX "banner_configuration_default_per_placement_idx" ON "banner_configuration" USING btree ("placement") WHERE "banner_configuration"."is_default" = true;--> statement-breakpoint
CREATE UNIQUE INDEX "banner_image_configuration_sort_locale_idx" ON "banner_image" USING btree ("banner_configuration_id","sort_order","locale");--> statement-breakpoint
CREATE INDEX "banner_image_configuration_id_idx" ON "banner_image" USING btree ("banner_configuration_id");
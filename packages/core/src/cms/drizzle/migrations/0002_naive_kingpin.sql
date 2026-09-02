CREATE TABLE "banner_schedule" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"banner_configuration_id" uuid NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "banner_schedule_ends_after_starts_check" CHECK ("banner_schedule"."ends_at" > "banner_schedule"."starts_at")
);
--> statement-breakpoint
ALTER TABLE "banner_schedule" ADD CONSTRAINT "banner_schedule_banner_configuration_id_banner_configuration_id_fk" FOREIGN KEY ("banner_configuration_id") REFERENCES "public"."banner_configuration"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "banner_schedule_configuration_id_idx" ON "banner_schedule" USING btree ("banner_configuration_id");--> statement-breakpoint
CREATE INDEX "banner_schedule_starts_ends_idx" ON "banner_schedule" USING btree ("starts_at","ends_at");
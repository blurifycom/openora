CREATE TABLE "global_kyc_config" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"singleton_key" text DEFAULT 'global' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone,
	"updated_by" uuid,
	CONSTRAINT "global_kyc_config_singleton_key_unique" UNIQUE("singleton_key")
);
--> statement-breakpoint
ALTER TABLE "geo_rule" ADD COLUMN "redirect_ip" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "geo_rule" ADD COLUMN "kyc_required" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "geo_rule" ADD COLUMN "updated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "geo_rule" ADD COLUMN "updated_by" uuid;
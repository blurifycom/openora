CREATE TABLE "provider_geo_rule" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider_id" uuid NOT NULL,
	"country_code" text NOT NULL,
	"reason" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "provider_geo_rule_provider_id_country_code_key" ON "provider_geo_rule" USING btree ("provider_id","country_code");--> statement-breakpoint
CREATE INDEX "provider_geo_rule_provider_id_idx" ON "provider_geo_rule" USING btree ("provider_id");--> statement-breakpoint
CREATE INDEX "provider_geo_rule_country_code_idx" ON "provider_geo_rule" USING btree ("country_code");
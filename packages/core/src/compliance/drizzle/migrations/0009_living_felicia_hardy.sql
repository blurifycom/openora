CREATE TABLE "game_geo_rule" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"game_id" uuid NOT NULL,
	"country_code" text NOT NULL,
	"reason" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "game_geo_rule_game_id_country_code_key" ON "game_geo_rule" USING btree ("game_id","country_code");--> statement-breakpoint
CREATE INDEX "game_geo_rule_game_id_idx" ON "game_geo_rule" USING btree ("game_id");--> statement-breakpoint
CREATE INDEX "game_geo_rule_country_code_idx" ON "game_geo_rule" USING btree ("country_code");
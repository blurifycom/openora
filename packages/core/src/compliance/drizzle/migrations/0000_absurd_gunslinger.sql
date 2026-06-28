CREATE TABLE "geo_rule" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"country_code" text NOT NULL,
	"action" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "geo_rule_country_code_unique" UNIQUE("country_code")
);
--> statement-breakpoint
CREATE TABLE "user_limit" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"type" text NOT NULL,
	"amount" real NOT NULL,
	"period" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "user_limit_user_id_type_period_key" ON "user_limit" USING btree ("user_id","type","period");--> statement-breakpoint
CREATE INDEX "user_limit_user_id_idx" ON "user_limit" USING btree ("user_id");

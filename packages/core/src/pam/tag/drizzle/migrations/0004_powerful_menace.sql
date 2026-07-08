CREATE TABLE "tag_rule" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tag_key" "tag_key" NOT NULL,
	"is_enabled" boolean DEFAULT false NOT NULL,
	"threshold_amount" numeric,
	"threshold_days" integer,
	"threshold_count" integer,
	"updated_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tag_rule_tag_key_unique" UNIQUE("tag_key")
);

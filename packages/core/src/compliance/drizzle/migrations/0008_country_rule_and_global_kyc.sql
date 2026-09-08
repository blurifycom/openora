-- BF-534: rewrites the old binary allow/block geo rule into three independent per-country
-- flags (blacklisted, redirectIp, kycRequired), and adds a new global_kyc_config singleton
-- for the platform-wide KYC toggle. Hand-authored (not drizzle-kit generated) because the
-- geo_rule -> country_rule rename needs a data backfill from the dropped `action` column
-- before it is dropped - see 0006_backfill_session_limit_currency.sql for the same pattern
-- in this module. `action` was a plain `text` column (geoRuleActions was a TS-only enum,
-- never a Postgres enum type), so there is no DROP TYPE step.
ALTER TABLE "geo_rule" RENAME TO "country_rule";--> statement-breakpoint
ALTER TABLE "country_rule" RENAME CONSTRAINT "geo_rule_country_code_unique" TO "country_rule_country_code_unique";--> statement-breakpoint
ALTER TABLE "country_rule" ADD COLUMN "blacklisted" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "country_rule" ADD COLUMN "redirect_ip" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "country_rule" ADD COLUMN "kyc_required" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "country_rule" ADD COLUMN "updated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "country_rule" ADD COLUMN "updated_by" uuid;--> statement-breakpoint
UPDATE "country_rule" SET "blacklisted" = ("action" = 'block');--> statement-breakpoint
ALTER TABLE "country_rule" DROP COLUMN "action";--> statement-breakpoint
CREATE TABLE "global_kyc_config" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"singleton_key" text DEFAULT 'global' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone,
	"updated_by" uuid,
	CONSTRAINT "global_kyc_config_singleton_key_unique" UNIQUE("singleton_key")
);

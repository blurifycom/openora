CREATE TYPE "public"."promo_weight_scope" AS ENUM('game', 'category', 'product', 'default');--> statement-breakpoint
CREATE TABLE "promo_weight" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"profile_id" uuid NOT NULL,
	"scope" "promo_weight_scope" NOT NULL,
	"scope_ref" text,
	"contribution_percent" numeric(5, 2) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "promo_weight_contribution_percent_range" CHECK ("promo_weight"."contribution_percent" >= 0 AND "promo_weight"."contribution_percent" <= 100)
);
--> statement-breakpoint
CREATE TABLE "promo_weight_profile" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "promo_weight_profile_name_unique" UNIQUE("name")
);
--> statement-breakpoint
ALTER TABLE "promo_weight" ADD CONSTRAINT "promo_weight_profile_id_promo_weight_profile_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."promo_weight_profile"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "promo_weight_profile_id_scope_scope_ref_idx" ON "promo_weight" USING btree ("profile_id","scope","scope_ref");--> statement-breakpoint
CREATE UNIQUE INDEX "promo_weight_profile_id_default_idx" ON "promo_weight" USING btree ("profile_id") WHERE "promo_weight"."scope" = 'default';
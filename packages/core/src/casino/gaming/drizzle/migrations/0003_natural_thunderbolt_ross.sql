CREATE TABLE "game_category" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"icon" text,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "game_category_game" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"game_id" uuid NOT NULL,
	"category_id" uuid NOT NULL
);
--> statement-breakpoint
CREATE TABLE "game_provider" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"aggregator_vendor_id" text,
	"logo_url" text,
	"is_active" boolean DEFAULT false NOT NULL,
	"metadata" jsonb,
	"updated_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "game" ALTER COLUMN "provider" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "game" ALTER COLUMN "category" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "game" ALTER COLUMN "is_active" SET DEFAULT false;--> statement-breakpoint
ALTER TABLE "game" ADD COLUMN "slug" text;--> statement-breakpoint
ALTER TABLE "game" ADD COLUMN "provider_id" uuid;--> statement-breakpoint
ALTER TABLE "game" ADD COLUMN "aggregator" text;--> statement-breakpoint
ALTER TABLE "game_category_game" ADD CONSTRAINT "game_category_game_game_id_game_id_fk" FOREIGN KEY ("game_id") REFERENCES "public"."game"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "game_category_game" ADD CONSTRAINT "game_category_game_category_id_game_category_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."game_category"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "game_category_slug_key" ON "game_category" USING btree ("slug");--> statement-breakpoint
CREATE UNIQUE INDEX "game_category_game_key" ON "game_category_game" USING btree ("game_id","category_id");--> statement-breakpoint
CREATE INDEX "game_category_game_category_id_idx" ON "game_category_game" USING btree ("category_id");--> statement-breakpoint
CREATE UNIQUE INDEX "game_provider_slug_key" ON "game_provider" USING btree ("slug");--> statement-breakpoint
CREATE UNIQUE INDEX "game_provider_aggregator_vendor_id_key" ON "game_provider" USING btree ("aggregator_vendor_id");--> statement-breakpoint
ALTER TABLE "game" ADD CONSTRAINT "game_provider_id_game_provider_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."game_provider"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "game_slug_key" ON "game" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "game_provider_id_idx" ON "game" USING btree ("provider_id");--> statement-breakpoint
CREATE INDEX "game_aggregator_idx" ON "game" USING btree ("aggregator");
CREATE TABLE "lobby_layout" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"layout_key" text DEFAULT 'global' NOT NULL,
	"version" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lobby_section" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"type" text NOT NULL,
	"config" jsonb NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"is_enabled" boolean DEFAULT true NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "lobby_layout_layout_key_key" ON "lobby_layout" USING btree ("layout_key");--> statement-breakpoint
CREATE INDEX "lobby_section_sort_order_idx" ON "lobby_section" USING btree ("sort_order");
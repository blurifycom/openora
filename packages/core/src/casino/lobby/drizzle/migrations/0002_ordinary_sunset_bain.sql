DROP INDEX "lobby_section_sort_order_idx";--> statement-breakpoint
ALTER TABLE "lobby_section" ADD COLUMN "layout_key" text DEFAULT 'global' NOT NULL;--> statement-breakpoint
CREATE INDEX "lobby_section_layout_key_sort_order_idx" ON "lobby_section" USING btree ("layout_key","sort_order");
CREATE EXTENSION IF NOT EXISTS pg_trgm;--> statement-breakpoint
CREATE INDEX "user_email_trgm_idx" ON "user" USING gin ("email" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "player_name_trgm_idx" ON "player" USING gin ("display_name" gin_trgm_ops);

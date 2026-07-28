CREATE TYPE "public"."game_type" AS ENUM('original', 'casino', 'sportsbook');--> statement-breakpoint
ALTER TABLE "game" ADD COLUMN "game_type" "game_type" DEFAULT 'casino' NOT NULL;--> statement-breakpoint
CREATE INDEX "game_round_game_id_started_at_idx" ON "game_round" USING btree ("game_id","started_at");--> statement-breakpoint
CREATE INDEX "game_round_started_at_idx" ON "game_round" USING btree ("started_at");

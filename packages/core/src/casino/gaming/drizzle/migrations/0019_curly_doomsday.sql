DROP INDEX "game_round_user_id_idx";--> statement-breakpoint
CREATE INDEX "game_round_user_id_started_at_idx" ON "game_round" USING btree ("user_id","started_at");
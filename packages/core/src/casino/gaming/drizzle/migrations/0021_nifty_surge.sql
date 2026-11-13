CREATE TYPE "public"."game_wager_product" AS ENUM('casino', 'live-casino', 'sportsbook', 'pvp');--> statement-breakpoint
ALTER TABLE "game" ADD COLUMN "wager_product" "game_wager_product";--> statement-breakpoint
ALTER TABLE "game" ADD COLUMN "rtp" numeric(19, 18);--> statement-breakpoint
ALTER TABLE "game_round" ADD COLUMN "wager_product" "game_wager_product";--> statement-breakpoint
ALTER TABLE "game_round" ADD COLUMN "rtp" numeric(19, 18);--> statement-breakpoint
ALTER TABLE "ledger_game" ADD COLUMN "wager_product" "game_wager_product";--> statement-breakpoint
ALTER TABLE "ledger_game" ADD COLUMN "rtp" numeric(19, 18);--> statement-breakpoint
ALTER TABLE "game" ADD CONSTRAINT "game_rtp_range_check" CHECK ("game"."rtp" IS NULL OR ("game"."rtp" >= 0 AND "game"."rtp" <= 1));
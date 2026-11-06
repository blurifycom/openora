CREATE TYPE "public"."wallet_wager_product" AS ENUM('casino', 'live-casino', 'sportsbook', 'pvp');--> statement-breakpoint
ALTER TABLE "wallet_transaction" ADD COLUMN "wager_product" "wallet_wager_product";--> statement-breakpoint
ALTER TABLE "wallet_transaction" ADD COLUMN "wager_rtp" numeric(19, 18);
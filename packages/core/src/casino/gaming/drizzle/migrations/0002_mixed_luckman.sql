ALTER TABLE "game_round" ADD COLUMN "bet_amount" numeric(18, 2) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "game_round" ADD COLUMN "win_amount" numeric(18, 2) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "game_round" DROP COLUMN "bet_amount_cents";--> statement-breakpoint
ALTER TABLE "game_round" DROP COLUMN "win_amount_cents";

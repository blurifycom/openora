ALTER TABLE "game_round" ALTER COLUMN "bet_amount" SET DATA TYPE numeric(38, 18);--> statement-breakpoint
ALTER TABLE "game_round" ALTER COLUMN "bet_amount" SET DEFAULT '0';--> statement-breakpoint
ALTER TABLE "game_round" ALTER COLUMN "win_amount" SET DATA TYPE numeric(38, 18);--> statement-breakpoint
ALTER TABLE "game_round" ALTER COLUMN "win_amount" SET DEFAULT '0';
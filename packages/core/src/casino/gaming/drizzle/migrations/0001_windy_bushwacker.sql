ALTER TABLE "game_round" ADD COLUMN "bet_amount_cents" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "game_round" ADD COLUMN "win_amount_cents" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "game_round" DROP COLUMN "bet_amount";--> statement-breakpoint
ALTER TABLE "game_round" DROP COLUMN "win_amount";

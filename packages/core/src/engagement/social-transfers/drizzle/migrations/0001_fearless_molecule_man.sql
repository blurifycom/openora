ALTER TABLE "player_donate" ALTER COLUMN "amount" SET DATA TYPE numeric(38, 18);--> statement-breakpoint
ALTER TABLE "player_gift" ALTER COLUMN "amount" SET DATA TYPE numeric(38, 18);--> statement-breakpoint
ALTER TABLE "player_rain" ALTER COLUMN "amount" SET DATA TYPE numeric(38, 18);--> statement-breakpoint
ALTER TABLE "player_rain" ALTER COLUMN "per_recipient" SET DATA TYPE numeric(38, 18);--> statement-breakpoint
ALTER TABLE "player_rain_receiver" ALTER COLUMN "amount" SET DATA TYPE numeric(38, 18);
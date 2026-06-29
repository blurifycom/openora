ALTER TABLE "leaderboard" ALTER COLUMN "period_start" SET DATA TYPE timestamp with time zone;--> statement-breakpoint
ALTER TABLE "leaderboard" ALTER COLUMN "created_at" SET DATA TYPE timestamp with time zone;--> statement-breakpoint
ALTER TABLE "leaderboard" ALTER COLUMN "created_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "leaderboard_entry" ALTER COLUMN "updated_at" SET DATA TYPE timestamp with time zone;--> statement-breakpoint
ALTER TABLE "leaderboard_entry" ALTER COLUMN "updated_at" SET DEFAULT now();

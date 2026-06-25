ALTER TYPE "public"."LeaderboardMetric" RENAME TO "leaderboard_metric";
--> statement-breakpoint
ALTER TYPE "public"."LeaderboardPeriod" RENAME TO "leaderboard_period";
--> statement-breakpoint
ALTER TABLE "public"."leaderboard" RENAME COLUMN "periodStart" TO "period_start";
--> statement-breakpoint
ALTER TABLE "public"."leaderboard" RENAME COLUMN "createdAt" TO "created_at";
--> statement-breakpoint
ALTER TABLE "public"."leaderboard_entry" RENAME COLUMN "leaderboardId" TO "leaderboard_id";
--> statement-breakpoint
ALTER TABLE "public"."leaderboard_entry" RENAME COLUMN "userId" TO "user_id";
--> statement-breakpoint
ALTER TABLE "public"."leaderboard_entry" RENAME COLUMN "updatedAt" TO "updated_at";
--> statement-breakpoint
ALTER TABLE "public"."leaderboard_entry" RENAME CONSTRAINT "leaderboard_entry_leaderboardId_leaderboard_id_fk" TO "leaderboard_entry_leaderboard_id_leaderboard_id_fk";
--> statement-breakpoint
ALTER INDEX "public"."leaderboard_entry_leaderboardId_idx" RENAME TO "leaderboard_entry_leaderboard_id_idx";

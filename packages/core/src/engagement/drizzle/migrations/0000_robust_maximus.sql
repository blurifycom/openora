CREATE TYPE "public"."LeaderboardMetric" AS ENUM('wagers', 'wins');--> statement-breakpoint
CREATE TYPE "public"."LeaderboardPeriod" AS ENUM('daily', 'weekly');--> statement-breakpoint
CREATE TABLE "leaderboard" (
	"id" text PRIMARY KEY NOT NULL,
	"tenantId" text NOT NULL,
	"metric" "LeaderboardMetric" NOT NULL,
	"period" "LeaderboardPeriod" NOT NULL,
	"periodStart" timestamp NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "leaderboard_entry" (
	"id" text PRIMARY KEY NOT NULL,
	"tenantId" text NOT NULL,
	"leaderboardId" text NOT NULL,
	"userId" text NOT NULL,
	"score" numeric DEFAULT '0' NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "leaderboard_entry" ADD CONSTRAINT "leaderboard_entry_leaderboardId_leaderboard_id_fk" FOREIGN KEY ("leaderboardId") REFERENCES "public"."leaderboard"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "leaderboard_tenantId_idx" ON "leaderboard" USING btree ("tenantId");--> statement-breakpoint
CREATE UNIQUE INDEX "leaderboard_tenant_metric_period_idx" ON "leaderboard" USING btree ("tenantId","metric","period");--> statement-breakpoint
CREATE INDEX "leaderboard_entry_leaderboardId_idx" ON "leaderboard_entry" USING btree ("leaderboardId");--> statement-breakpoint
CREATE UNIQUE INDEX "leaderboard_entry_lb_user_idx" ON "leaderboard_entry" USING btree ("leaderboardId","userId");
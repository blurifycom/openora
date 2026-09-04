ALTER TABLE "chat_mute" ADD COLUMN "expiry_recorded_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "chat_platform_ban" ADD COLUMN "expiry_recorded_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "chat_platform_ban_expires_at_idx" ON "chat_platform_ban" USING btree ("expires_at");--> statement-breakpoint
-- Backfill: every mute/ban that had already lapsed before this release is stamped as
-- recorded without an audit entry being written for it. The sweep only ever writes an
-- entry it can date from the row's own expires_at, and for these rows that date is in
-- the past of a deployment that had no expiry trail at all - so the alternative is a
-- first cron tick emitting one entry per lapse the operator has ever issued. The trail
-- starts at this release instead; nothing that was traceable before becomes less so.
UPDATE "chat_mute"
SET "expiry_recorded_at" = "expires_at"
WHERE "lifted_at" IS NULL
  AND "expires_at" IS NOT NULL
  AND "expires_at" <= now();--> statement-breakpoint
UPDATE "chat_platform_ban"
SET "expiry_recorded_at" = "expires_at"
WHERE "lifted_at" IS NULL
  AND "expires_at" IS NOT NULL
  AND "expires_at" <= now();

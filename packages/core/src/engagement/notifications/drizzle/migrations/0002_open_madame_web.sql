ALTER TABLE "notification" ADD COLUMN "event_id" uuid;--> statement-breakpoint
CREATE UNIQUE INDEX "notification_event_id_idx" ON "notification" USING btree ("event_id");
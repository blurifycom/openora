DROP INDEX "chat_user_block_pair_key";--> statement-breakpoint
DROP INDEX "chat_user_ignore_pair_key";--> statement-breakpoint
ALTER TABLE "chat_user_block" ADD COLUMN "removed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "chat_user_ignore" ADD COLUMN "removed_at" timestamp with time zone;--> statement-breakpoint
CREATE UNIQUE INDEX "chat_user_block_pair_key" ON "chat_user_block" USING btree ("blocker_id","blocked_id") WHERE "chat_user_block"."removed_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "chat_user_ignore_pair_key" ON "chat_user_ignore" USING btree ("ignorer_id","ignored_id") WHERE "chat_user_ignore"."removed_at" IS NULL;
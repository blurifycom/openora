ALTER TABLE "social_user_block" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "social_user_block" CASCADE;--> statement-breakpoint
ALTER TABLE "friendship" RENAME COLUMN "responded_at" TO "accepted_at";--> statement-breakpoint
DROP INDEX "friendship_addressee_status_idx";--> statement-breakpoint
DROP INDEX "friendship_requester_status_idx";--> statement-breakpoint
ALTER TABLE "friendship" ADD COLUMN "refused_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "friendship_addressee_idx" ON "friendship" USING btree ("addressee_id");--> statement-breakpoint
CREATE INDEX "friendship_requester_idx" ON "friendship" USING btree ("requester_id");--> statement-breakpoint
ALTER TABLE "friendship" DROP COLUMN "status";--> statement-breakpoint
DROP TYPE "public"."friendship_status";
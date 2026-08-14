CREATE TYPE "public"."friendship_status" AS ENUM('pending', 'accepted');--> statement-breakpoint
CREATE TABLE "friendship" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"requester_id" uuid NOT NULL,
	"addressee_id" uuid NOT NULL,
	"status" "friendship_status" DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"responded_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "social_user_block" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"blocker_id" uuid NOT NULL,
	"blocked_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"removed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE UNIQUE INDEX "friendship_pair_key" ON "friendship" USING btree (LEAST("requester_id", "addressee_id"),GREATEST("requester_id", "addressee_id"));--> statement-breakpoint
CREATE INDEX "friendship_addressee_status_idx" ON "friendship" USING btree ("addressee_id","status");--> statement-breakpoint
CREATE INDEX "friendship_requester_status_idx" ON "friendship" USING btree ("requester_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "social_user_block_pair_key" ON "social_user_block" USING btree ("blocker_id","blocked_id") WHERE "social_user_block"."removed_at" IS NULL;--> statement-breakpoint
CREATE INDEX "social_user_block_blocked_idx" ON "social_user_block" USING btree ("blocked_id");
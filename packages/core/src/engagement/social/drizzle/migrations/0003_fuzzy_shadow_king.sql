DROP INDEX "friendship_pair_key";--> statement-breakpoint
ALTER TABLE "friendship" ADD COLUMN "removed_at" timestamp with time zone;--> statement-breakpoint
CREATE UNIQUE INDEX "friendship_pair_key" ON "friendship" USING btree (LEAST("requester_id", "addressee_id"),GREATEST("requester_id", "addressee_id")) WHERE "friendship"."removed_at" IS NULL;--> statement-breakpoint
ALTER TABLE "friendship" ADD CONSTRAINT "friendship_removed_requires_accepted_key" CHECK (NOT ("friendship"."removed_at" IS NOT NULL AND "friendship"."accepted_at" IS NULL));

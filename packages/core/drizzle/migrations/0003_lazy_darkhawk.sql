CREATE TABLE "ChatUserBlock" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"blockerId" uuid NOT NULL,
	"blockedId" uuid NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "chat_user_block_pair_key" ON "ChatUserBlock" USING btree ("blockerId","blockedId");--> statement-breakpoint
CREATE INDEX "chat_user_block_blocker_idx" ON "ChatUserBlock" USING btree ("blockerId");

ALTER TABLE "chat_room" ALTER COLUMN "category" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "chat_room" ALTER COLUMN "category" DROP NOT NULL;
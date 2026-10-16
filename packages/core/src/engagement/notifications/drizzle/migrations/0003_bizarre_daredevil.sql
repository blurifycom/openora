ALTER TABLE "notification" ALTER COLUMN "title" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "notification" ALTER COLUMN "body" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "notification" ADD COLUMN "params" jsonb;
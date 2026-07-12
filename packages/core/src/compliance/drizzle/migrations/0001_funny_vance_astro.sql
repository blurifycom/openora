ALTER TABLE "user_limit" ALTER COLUMN "amount" SET DATA TYPE numeric(18, 2);--> statement-breakpoint
ALTER TABLE "user_limit" ALTER COLUMN "amount" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "rg_exclusion" ADD COLUMN "is_permanent" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "user_limit" ADD COLUMN "minutes" integer;--> statement-breakpoint
ALTER TABLE "rg_exclusion" DROP COLUMN "permanent";
